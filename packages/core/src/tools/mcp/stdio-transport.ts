import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import {
  assertJsonRpcSuccess,
  isJsonRpcResponse,
  parseMessageLine,
  serializeMessage,
} from './json-rpc.js';
import type { MCPTransport } from './transport.js';
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from './types.js';

/** Options for {@link StdioMCPTransport}. */
export interface StdioMCPTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
  /** Grace period before escalating to SIGTERM. @defaultValue 1000 */
  shutdownGracePeriodMs?: number;
  /** Custom spawn for testing. */
  spawnFn?: typeof spawn;
  /** Inject streams directly (testing). */
  streams?: {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    kill?: () => void;
  };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 1_000;

/**
 * MCP stdio transport — newline-delimited JSON-RPC over subprocess stdin/stdout.
 */
export class StdioMCPTransport implements MCPTransport {
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string>;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGracePeriodMs: number;
  private readonly spawnFn: typeof spawn;
  private readonly injectedStreams?: StdioMCPTransportOptions['streams'];

  private process?: ChildProcess;
  private stdin?: NodeJS.WritableStream;
  private lineReader?: ReadlineInterface;
  private exitPromise?: Promise<void>;
  private connected = false;
  private closing = false;
  private messageHandler?: (message: JsonRpcMessage) => void;
  private disconnectHandlers: Array<(error?: Error) => void> = [];

  private readonly pending = new Map<
    number | string,
    {
      resolve: (message: JsonRpcMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * @param options - Command, args, and optional injected streams for tests.
   */
  constructor(options: StdioMCPTransportOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env;
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownGracePeriodMs =
      options.shutdownGracePeriodMs ?? DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
    this.spawnFn = options.spawnFn ?? spawn;
    this.injectedStreams = options.streams;
  }

  /** @inheritdoc */
  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }

    if (this.injectedStreams) {
      this.stdin = this.injectedStreams.stdin;
      this.attachStdout(this.injectedStreams.stdout);
      this.connected = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.env },
          cwd: this.cwd,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      let settled = false;
      const finalize = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      child.once('error', (err) => {
        if (!settled) {
          finalize(err);
        } else if (this.connected) {
          this.handleDisconnect(err);
        }
      });

      this.exitPromise = new Promise<void>((resolveExit) => {
        child.once('exit', () => {
          if (this.connected) {
            this.handleDisconnect(new Error('MCP stdio process exited'));
          }
          resolveExit();
        });
      });

      child.stderr?.on('data', () => {
        // stderr is logging only per MCP spec
      });

      if (!child.stdin || !child.stdout) {
        finalize(new Error('MCP stdio process missing stdin/stdout pipes'));
        return;
      }

      this.process = child;
      this.stdin = child.stdin;
      this.attachStdout(child.stdout);
      this.connected = true;
      finalize();
    });
  }

  /** @inheritdoc */
  request(message: JsonRpcRequest): Promise<JsonRpcMessage> {
    if (!this.connected || !this.stdin) {
      return Promise.reject(new Error('MCP stdio transport is not connected'));
    }
    if (message.id === undefined) {
      return Promise.reject(new Error('JSON-RPC request requires an id'));
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id as number | string);
        reject(new Error(`MCP request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(message.id as number | string, { resolve, reject, timer });

      this.stdin!.write(serializeMessage(message), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(message.id as number | string);
          reject(error);
        }
      });
    });
  }

  /** @inheritdoc */
  async notify(message: JsonRpcNotification): Promise<void> {
    if (!this.connected || !this.stdin) {
      throw new Error('MCP stdio transport is not connected');
    }

    await new Promise<void>((resolve, reject) => {
      this.stdin!.write(serializeMessage(message), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /** @inheritdoc */
  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  /** @inheritdoc */
  isConnected(): boolean {
    return this.connected;
  }

  /** @inheritdoc */
  onDisconnect(handler: (error?: Error) => void): void {
    this.disconnectHandlers.push(handler);
  }

  /**
   * Gracefully close the transport.
   *
   * For real subprocesses: closes stdin, then SIGTERM after the grace period,
   * then SIGKILL if the process still hasn't exited.
   */
  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.connected = false;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP stdio transport closed'));
    }
    this.pending.clear();

    this.lineReader?.close();
    this.lineReader = undefined;

    const child = this.process;
    if (!child) {
      if (this.injectedStreams?.kill) {
        this.injectedStreams.kill();
      }
      this.stdin = undefined;
      this.closing = false;
      return;
    }

    child.stdin?.end();

    try {
      const exited = await waitForExitOrTimeout(this.exitPromise, this.shutdownGracePeriodMs);
      if (!exited && !child.killed) {
        child.kill('SIGTERM');
        const exitedAfterTerm = await waitForExitOrTimeout(
          this.exitPromise,
          this.shutdownGracePeriodMs,
        );
        if (!exitedAfterTerm && !child.killed) {
          child.kill('SIGKILL');
        }
      }
    } finally {
      this.process = undefined;
      this.stdin = undefined;
      this.exitPromise = undefined;
      this.closing = false;
    }
  }

  private attachStdout(stdout: NodeJS.ReadableStream): void {
    const lineReader = createInterface({ input: stdout });
    this.lineReader = lineReader;

    lineReader.on('line', (line) => {
      const message = parseMessageLine(line);
      if (!message) {
        return;
      }
      this.dispatchMessage(message);
    });

    stdout.on('end', () => {
      if (this.connected) {
        this.handleDisconnect(new Error('MCP stdio stdout closed'));
      }
    });
  }

  private dispatchMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message) && message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
        return;
      }
    }

    this.messageHandler?.(message);
  }

  private handleDisconnect(error: Error): void {
    this.connected = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.disconnectHandlers) {
      handler(error);
    }
  }
}

/** Extract JSON-RPC result from a stdio transport response. */
export function resolveStdioResult<T>(message: JsonRpcMessage): T {
  if (!isJsonRpcResponse(message)) {
    throw new Error('Expected JSON-RPC response');
  }
  return assertJsonRpcSuccess<T>(message);
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!exitPromise) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([exitPromise.then(() => true), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

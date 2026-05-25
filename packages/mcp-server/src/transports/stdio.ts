import type { JsonRpcResponse } from '../types.js';
import { parseInboundJsonRpcMessage } from '../json-rpc.js';
import type {
  MCPServerMessageHandler,
  MCPServerSession,
  MCPServerTransport,
} from './types.js';

/** Options for {@link McpStdioServerTransport}. */
export interface McpStdioServerTransportOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  handleSignals?: boolean;
  onSignal?: (signal: NodeJS.Signals) => void;
}

const STDIO_SESSION_ID = 'stdio';

/** MCP server stdio transport — newline-delimited JSON-RPC on stdin/stdout. */
export class McpStdioServerTransport implements MCPServerTransport {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly handleSignals: boolean;
  private readonly onSignal?: (signal: NodeJS.Signals) => void;

  private handler?: MCPServerMessageHandler;
  private onSessionConnect?: (session: MCPServerSession) => void;
  private buffer = '';
  private running = false;
  private readonly session: MCPServerSession = { id: STDIO_SESSION_ID, initialized: false };
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    this.flushBuffer();
  };
  private readonly onEnd = (): void => {
    void this.stop();
  };
  private signalHandlers: Array<{ signal: NodeJS.Signals; listener: () => void }> = [];

  constructor(options: McpStdioServerTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.handleSignals = options.handleSignals ?? true;
    this.onSignal = options.onSignal;
  }

  start(
    handler: MCPServerMessageHandler,
    options?: { onSessionConnect?: (session: MCPServerSession) => void },
  ): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }
    this.handler = handler;
    this.onSessionConnect = options?.onSessionConnect;
    this.running = true;
    this.session.initialized = false;
    this.onSessionConnect?.(this.session);

    this.input.on('data', this.onData);
    this.input.on('end', this.onEnd);

    if (this.handleSignals) {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const listener = (): void => {
          this.onSignal?.(signal);
          void this.stop();
        };
        process.on(signal, listener);
        this.signalHandlers.push({ signal, listener });
      }
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    this.running = false;

    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);

    for (const { signal, listener } of this.signalHandlers) {
      process.off(signal, listener);
    }
    this.signalHandlers = [];
    this.onSessionConnect = undefined;
    return Promise.resolve();
  }

  getConnectedClients(): number {
    return this.running ? 1 : 0;
  }

  send(response: JsonRpcResponse): void {
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  getSession(): MCPServerSession {
    return this.session;
  }

  private flushBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        void this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private async handleLine(line: string): Promise<void> {
    const handler = this.handler;
    if (!handler) {
      return;
    }

    let message;
    try {
      message = parseInboundJsonRpcMessage(line);
    } catch {
      this.send({
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    await handler(message, (response) => this.send(response), this.session);
  }
}

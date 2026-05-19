import { assertJsonRpcSuccess, isJsonRpcResponse, parseJsonRpcMessage } from './json-rpc.js';
import { SseParser, type SseEvent } from './sse-parser.js';
import type { MCPTransport } from './transport.js';
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from './types.js';

/** Parse an `endpoint` event payload, accepting both `{ url }` JSON and bare URL strings. */
function parseEndpointEventData(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && 'url' in parsed) {
      return String(parsed.url);
    }
  } catch {
    // Fall through to bare string handling.
  }
  return data;
}

/** Options for {@link SseMCPTransport}. */
export interface SseMCPTransportOptions {
  /** SSE endpoint URL (GET). */
  sseUrl: string;
  /** Optional HTTP headers. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Connection handshake timeout in milliseconds. */
  connectTimeoutMs?: number;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

type SseStreamChunk =
  | { done: true; value?: undefined }
  | { done: false; value: Uint8Array };

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SseStreamChunk> {
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      return { done: true };
    }
    if (result.value) {
      return { done: false, value: result.value };
    }
  }
}

/**
 * MCP HTTP+SSE transport (protocol 2024-11-05).
 *
 * Opens an SSE stream, receives the `endpoint` event with the POST URL,
 * then exchanges JSON-RPC messages via POST (client) and SSE `message` events (server).
 */
export class SseMCPTransport implements MCPTransport {
  private readonly sseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  private messageEndpoint?: string;
  private connected = false;
  private abortController?: AbortController;
  private readLoopPromise?: Promise<void>;
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
   * @param options - SSE URL, headers, and timeouts.
   */
  constructor(options: SseMCPTransportOptions) {
    this.sseUrl = options.sseUrl;
    this.headers = options.headers ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.abortController = new AbortController();

    const handshakeTimer = setTimeout(() => {
      this.abortController?.abort();
    }, this.connectTimeoutMs);

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const parser = new SseParser();
    const decoder = new TextDecoder();

    try {
      const response = await this.fetchFn(this.sseUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...this.headers,
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`MCP SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('MCP SSE connection failed: empty response body');
      }

      reader = response.body.getReader();

      const pendingEvents: SseEvent[] = [];

      while (!this.messageEndpoint) {
        const chunk = await readStreamChunk(reader);
        if (chunk.done) {
          throw new Error('MCP SSE stream closed before endpoint event');
        }
        const events = parser.feed(decoder.decode(chunk.value, { stream: true }));
        for (const event of events) {
          if (
            !this.messageEndpoint &&
            (event.event === 'endpoint' || (!event.event && event.data.startsWith('http')))
          ) {
            this.messageEndpoint = parseEndpointEventData(event.data);
            continue;
          }
          if (this.messageEndpoint && (event.event === 'message' || !event.event)) {
            pendingEvents.push(event);
          }
        }
      }

      this.messageEndpoint = new URL(this.messageEndpoint, this.sseUrl).toString();
      this.connected = true;

      clearTimeout(handshakeTimer);

      for (const event of pendingEvents) {
        this.dispatchSseData(event.data);
      }

      this.readLoopPromise = this.readSseLoop(reader, decoder, parser);
      reader = undefined;
    } catch (error) {
      clearTimeout(handshakeTimer);
      this.connected = false;
      this.abortController?.abort();
      reader?.cancel().catch(() => undefined);
      throw error;
    }
  }

  /** @inheritdoc */
  async request(message: JsonRpcRequest): Promise<JsonRpcMessage> {
    if (!this.connected || !this.messageEndpoint) {
      throw new Error('MCP SSE transport is not connected');
    }
    if (message.id === undefined) {
      throw new Error('JSON-RPC request requires an id');
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id as number | string);
        reject(new Error(`MCP request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(message.id as number | string, { resolve, reject, timer });

      void this.postMessage(message).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(message.id as number | string);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** @inheritdoc */
  async notify(message: JsonRpcNotification): Promise<void> {
    if (!this.connected || !this.messageEndpoint) {
      throw new Error('MCP SSE transport is not connected');
    }
    await this.postMessage(message);
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

  /** @inheritdoc */
  async close(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP SSE transport closed'));
    }
    this.pending.clear();
    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => undefined);
    }
  }

  private async postMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const response = await this.fetchFn(this.messageEndpoint!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.headers,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`MCP POST failed: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const text = await response.text();
      if (text.trim()) {
        this.dispatchSseData(text);
      }
    }
  }

  private async readSseLoop(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    parser: SseParser,
  ): Promise<void> {
    try {
      while (this.connected) {
        const chunk = await readStreamChunk(reader);
        if (chunk.done) {
          break;
        }
        const events = parser.feed(decoder.decode(chunk.value, { stream: true }));
        for (const event of events) {
          if (event.event === 'message' || (!event.event && event.data.startsWith('{'))) {
            this.dispatchSseData(event.data);
          }
        }
      }
    } catch (error) {
      if (this.connected) {
        this.notifyDisconnect(error instanceof Error ? error : new Error('MCP SSE stream disconnected'));
      }
    }
  }

  private notifyDisconnect(error?: Error): void {
    this.connected = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('MCP SSE stream disconnected'));
    }
    this.pending.clear();
    for (const handler of this.disconnectHandlers) {
      handler(error);
    }
  }

  private dispatchSseData(data: string): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(data);
    } catch {
      return;
    }

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
}

/** Extract JSON-RPC result from a transport response message. */
export function resolveTransportResult<T>(message: JsonRpcMessage): T {
  if (!isJsonRpcResponse(message)) {
    throw new Error('Expected JSON-RPC response');
  }
  return assertJsonRpcSuccess<T>(message);
}

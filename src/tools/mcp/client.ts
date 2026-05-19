import {
  RequestIdGenerator,
  buildNotification,
  buildRequest,
  isJsonRpcNotification,
  normalizeToolCallResult,
} from './json-rpc.js';
import { normalizeMcpInputSchema } from './mcp-tool.js';
import { SseMCPTransport, resolveTransportResult } from './sse-transport.js';
import { StdioMCPTransport } from './stdio-transport.js';
import type { MCPTransport } from './transport.js';
import type { JsonRpcMessage } from './types.js';
import type {
  MCPClientInfo,
  MCPClientOptions,
  MCPInitializeResult,
  MCPToolCallResult,
  MCPToolDefinition,
  MCPToolsListResult,
} from './types.js';
import { MCP_PROTOCOL_VERSION } from './types.js';

const DEFAULT_CLIENT_INFO: MCPClientInfo = {
  name: 'ottrix',
  version: '1.0.0',
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * MCP client — connects via SSE or stdio, performs the initialize handshake,
 * and exposes `tools/list` and `tools/call`.
 */
export class MCPClient {
  private readonly config: MCPClientOptions['config'];
  private readonly clientInfo: MCPClientInfo;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn?: typeof fetch;
  private readonly spawnFn?: typeof import('node:child_process').spawn;
  private readonly injectedTransport?: MCPTransport;

  private readonly idGenerator = new RequestIdGenerator();
  private transport?: MCPTransport;
  private initialized = false;
  private lastInitializeResult?: MCPInitializeResult;
  private readonly toolsChangedListeners = new Set<() => void>();
  private readonly notificationListeners = new Set<(message: JsonRpcMessage) => void>();

  /**
   * @param options - Transport config and client identity.
   */
  constructor(options: MCPClientOptions) {
    this.config = options.config;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? options.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch;
    this.spawnFn = options.spawn;
    this.injectedTransport = options.transport;
  }

  /** Whether the client has completed the MCP initialize handshake. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** Whether the underlying transport is connected. */
  isConnected(): boolean {
    return this.transport?.isConnected() ?? false;
  }

  /**
   * Connect to the MCP server and run the initialize → initialized handshake.
   *
   * If a stale transport from a previous connection is still around, it is
   * closed before opening a new one. If the handshake fails, the new transport
   * is closed to avoid leaks.
   */
  async connect(): Promise<MCPInitializeResult> {
    if (this.initialized && this.transport?.isConnected() && this.lastInitializeResult) {
      return this.lastInitializeResult;
    }

    await this.closeTransport();

    this.idGenerator.reset(1);
    const transport = this.createTransport();
    this.transport = transport;

    try {
      await transport.connect();

      transport.onMessage((message) => {
        this.handleServerMessage(message);
      });

      const initResponse = await transport.request(
        buildRequest(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: this.clientInfo,
          },
          this.idGenerator.generate(),
        ),
      );

      const result = resolveTransportResult<MCPInitializeResult>(initResponse);
      await transport.notify(buildNotification('notifications/initialized'));

      this.initialized = true;
      this.lastInitializeResult = result;
      return result;
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (this.transport === transport) {
        this.transport = undefined;
      }
      this.initialized = false;
      this.lastInitializeResult = undefined;
      throw error;
    }
  }

  /**
   * List all tools from the server (handles pagination).
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    await this.ensureConnected();

    const tools: MCPToolDefinition[] = [];
    let cursor: string | undefined;

    do {
      const params = cursor ? { cursor } : {};
      const response = await this.transport!.request(
        buildRequest('tools/list', params, this.idGenerator.generate()),
      );
      const result = resolveTransportResult<MCPToolsListResult>(response);
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    return tools.map((tool) => ({
      ...tool,
      inputSchema: normalizeMcpInputSchema(tool.inputSchema),
    }));
  }

  /**
   * Invoke a tool via `tools/call`.
   *
   * Returns the structured {@link MCPToolCallResult}. Throws {@link MCPToolError}
   * when the server responds with `isError: true`, or {@link MCPProtocolError}
   * for transport-level failures.
   *
   * @param name - MCP tool name (not namespaced).
   * @param args - Tool arguments object.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
    await this.ensureConnected();

    const response = await this.transport!.request(
      buildRequest('tools/call', { name, arguments: args }, this.idGenerator.generate()),
    );

    const result = resolveTransportResult<unknown>(response);
    return normalizeToolCallResult(result);
  }

  /** Disconnect from the server. */
  async disconnect(): Promise<void> {
    this.initialized = false;
    this.lastInitializeResult = undefined;
    await this.closeTransport();
  }

  /** Expose the underlying transport (for advanced use / testing). */
  getTransport(): MCPTransport | undefined {
    return this.transport;
  }

  /**
   * Subscribe to `notifications/tools/list_changed`.
   *
   * The handler is invoked synchronously when the server emits the
   * notification; call {@link listTools} (or use {@link MCPToolProvider}'s
   * `onToolsChanged`) to refresh the cached tool set.
   *
   * @returns Unsubscribe function.
   */
  onToolsChanged(handler: () => void): () => void {
    this.toolsChangedListeners.add(handler);
    return () => this.toolsChangedListeners.delete(handler);
  }

  /**
   * Subscribe to any unsolicited JSON-RPC notification from the server
   * (responses to client requests are routed separately).
   *
   * @returns Unsubscribe function.
   */
  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.notificationListeners.add(handler);
    return () => this.notificationListeners.delete(handler);
  }

  private handleServerMessage(message: JsonRpcMessage): void {
    if (!isJsonRpcNotification(message)) {
      return;
    }

    for (const listener of this.notificationListeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break the transport read loop.
      }
    }

    if (message.method === 'notifications/tools/list_changed') {
      for (const listener of this.toolsChangedListeners) {
        try {
          listener();
        } catch {
          // Same: never throw out of the transport's dispatch path.
        }
      }
    }
  }

  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      return;
    }
    this.transport = undefined;
    await transport.close().catch(() => undefined);
  }

  private createTransport(): MCPTransport {
    if (this.injectedTransport) {
      return this.injectedTransport;
    }

    if (this.config.transport === 'sse') {
      return new SseMCPTransport({
        sseUrl: this.config.url,
        headers: this.config.headers,
        requestTimeoutMs: this.requestTimeoutMs,
        fetch: this.fetchFn,
      });
    }

    return new StdioMCPTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      cwd: this.config.cwd,
      requestTimeoutMs: this.requestTimeoutMs,
      spawnFn: this.spawnFn,
    });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.initialized || !this.transport?.isConnected()) {
      await this.connect();
    }
  }
}

import { MCPClient } from './client.js';
import { createMCPTool, type MCPTool } from './mcp-tool.js';
import type { BaseTool } from '../tool.js';
import type {
  MCPClientInfo,
  MCPConnectionState,
  MCPReconnectOptions,
  MCPServerConfig,
  MCPToolProviderOptions,
} from './types.js';

const DEFAULT_RECONNECT: MCPReconnectOptions = {
  enabled: true,
  maxAttempts: 0,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/**
 * Manages a single MCP server connection and exposes its tools as {@link BaseTool} instances.
 *
 * Supports automatic reconnection with exponential backoff after disconnect.
 */
export class MCPToolProvider {
  private readonly config: MCPServerConfig;
  private readonly namespace: string;
  private readonly reconnect: MCPReconnectOptions;
  private readonly clientInfo?: MCPClientInfo;
  private readonly fetchFn?: typeof fetch;
  private readonly spawnFn?: typeof import('node:child_process').spawn;
  private readonly requestTimeoutMs?: number;
  private readonly injectedTransport?: import('./transport.js').MCPTransport;

  private client?: MCPClient;
  private tools: MCPTool[] = [];
  private state: MCPConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionalDisconnect = false;
  private unsubscribeToolsChanged?: () => void;
  private readonly toolsChangedListeners = new Set<(tools: BaseTool[]) => void>();
  private refreshInFlight?: Promise<void>;

  /**
   * @param options - Server config, namespace, and reconnection policy.
   */
  constructor(options: MCPToolProviderOptions) {
    this.config = options.config;
    this.namespace = options.namespace ?? 'mcp';
    this.clientInfo = options.clientInfo;
    this.fetchFn = options.fetch;
    this.spawnFn = options.spawn;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.injectedTransport = options.transport;

    if (options.reconnect === false) {
      this.reconnect = { ...DEFAULT_RECONNECT, enabled: false };
    } else if (options.reconnect === true || options.reconnect === undefined) {
      this.reconnect = { ...DEFAULT_RECONNECT };
    } else {
      this.reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
    }
  }

  /** Current connection state. */
  getState(): MCPConnectionState {
    return this.state;
  }

  /** Namespace prefix applied to tool names. */
  getNamespace(): string {
    return this.namespace;
  }

  /**
   * Connect to the MCP server, run the handshake, and discover tools.
   */
  async connect(): Promise<BaseTool[]> {
    this.intentionalDisconnect = false;
    this.clearReconnectTimer();
    this.state = 'connecting';

    try {
      this.client = new MCPClient({
        config: this.config,
        clientInfo: this.clientInfo,
        fetch: this.fetchFn,
        spawn: this.spawnFn,
        requestTimeoutMs: this.requestTimeoutMs,
        transport: this.injectedTransport,
      });

      await this.client.connect();
      this.client.getTransport()?.onDisconnect(() => {
        this.scheduleReconnect();
      });

      this.unsubscribeToolsChanged?.();
      this.unsubscribeToolsChanged = this.client.onToolsChanged(() => {
        void this.refreshTools().catch(() => undefined);
      });

      const definitions = await this.client.listTools();
      this.tools = definitions.map((def) =>
        createMCPTool(def, this.client!, { namespace: this.namespace }),
      );

      this.state = 'connected';
      this.reconnectAttempts = 0;
      return this.getTools();
    } catch (error) {
      this.state = 'disconnected';
      throw error;
    }
  }

  /**
   * Re-fetch the tool list from the server and emit `onToolsChanged`.
   *
   * Concurrent calls de-duplicate to a single in-flight refresh.
   */
  refreshTools(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const promise = (async () => {
      if (!this.client?.isConnected()) {
        return;
      }
      const definitions = await this.client.listTools();
      this.tools = definitions.map((def) =>
        createMCPTool(def, this.client!, { namespace: this.namespace }),
      );
      const snapshot = this.getTools();
      for (const listener of this.toolsChangedListeners) {
        try {
          listener(snapshot);
        } catch {
          // Listener errors must not break the refresh loop.
        }
      }
    })().finally(() => {
      this.refreshInFlight = undefined;
    });

    this.refreshInFlight = promise;
    return promise;
  }

  /**
   * Subscribe to tool-list changes (driven by `notifications/tools/list_changed`
   * from the server or manual {@link refreshTools} calls).
   *
   * @returns Unsubscribe function.
   */
  onToolsChanged(handler: (tools: BaseTool[]) => void): () => void {
    this.toolsChangedListeners.add(handler);
    return () => this.toolsChangedListeners.delete(handler);
  }

  /**
   * Disconnect and stop reconnection attempts.
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    this.unsubscribeToolsChanged?.();
    this.unsubscribeToolsChanged = undefined;
    this.state = 'disconnected';
    this.tools = [];
    await this.client?.disconnect();
    this.client = undefined;
  }

  /**
   * Return discovered tools (empty until {@link connect} succeeds).
   */
  getTools(): BaseTool[] {
    return [...this.tools];
  }

  /** Underlying MCP client (if connected). */
  getClient(): MCPClient | undefined {
    return this.client;
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || !this.reconnect.enabled) {
      this.state = 'disconnected';
      return;
    }

    const maxAttempts = this.reconnect.maxAttempts ?? 0;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.state = 'disconnected';
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts += 1;

    const initial = this.reconnect.initialDelayMs ?? 1_000;
    const maxDelay = this.reconnect.maxDelayMs ?? 30_000;
    const delay = Math.min(initial * 2 ** (this.reconnectAttempts - 1), maxDelay);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        await this.client?.disconnect().catch(() => undefined);
        await this.connect();
      })().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

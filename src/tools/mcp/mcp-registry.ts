import type { BaseTool } from '../tool.js';
import { MCPToolProvider } from './provider.js';
import type { MCPServerConfig, MCPToolProviderOptions } from './types.js';

/** Options when adding a server to {@link MCPRegistry}. */
export interface MCPRegistryServerOptions {
  /** MCP server connection config. */
  config: MCPServerConfig;
  /** Override provider options (reconnect, clientInfo, etc.). */
  providerOptions?: Omit<MCPToolProviderOptions, 'config' | 'namespace'>;
}

/** Per-server result from {@link MCPRegistry.connectAll}. */
export interface MCPConnectResult {
  /** Server name registered via {@link MCPRegistry.addServer}. */
  name: string;
  /** Whether the connection succeeded. */
  status: 'fulfilled' | 'rejected';
  /** Failure reason when `status` is `'rejected'`. */
  reason?: unknown;
}

/** Aggregated failure for {@link MCPRegistry.connectAll} when `throwOnFailure` is set. */
export class MCPRegistryConnectError extends Error {
  /** Per-server connection results. */
  readonly results: MCPConnectResult[];

  constructor(results: MCPConnectResult[]) {
    const failures = results.filter((r) => r.status === 'rejected');
    super(
      `MCP registry failed to connect ${failures.length} of ${results.length} servers: ${failures
        .map((f) => f.name)
        .join(', ')}`,
    );
    this.name = 'MCPRegistryConnectError';
    this.results = results;
  }
}

/**
 * Manages multiple {@link MCPToolProvider} instances and merges their tools
 * with per-server namespacing.
 */
export class MCPRegistry {
  private readonly providers = new Map<string, MCPToolProvider>();

  /**
   * Register an MCP server by name. Does not connect automatically — call {@link connectAll}.
   */
  addServer(name: string, config: MCPServerConfig): this;
  addServer(name: string, options: MCPRegistryServerOptions): this;
  addServer(name: string, configOrOptions: MCPServerConfig | MCPRegistryServerOptions): this {
    const options: MCPRegistryServerOptions =
      'transport' in configOrOptions
        ? { config: configOrOptions }
        : configOrOptions;

    const provider = new MCPToolProvider({
      namespace: name,
      config: options.config,
      ...options.providerOptions,
    });

    this.providers.set(name, provider);
    return this;
  }

  /**
   * Remove a server and disconnect its provider.
   */
  async removeServer(name: string): Promise<boolean> {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }
    await provider.disconnect();
    this.providers.delete(name);
    return true;
  }

  /** Get a provider by server name. */
  getProvider(name: string): MCPToolProvider | undefined {
    return this.providers.get(name);
  }

  /** Registered server names. */
  serverNames(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Connect all registered servers in parallel.
   *
   * By default any failing server is reported via the returned results array
   * and successful providers stay connected. Pass `{ throwOnFailure: true }`
   * to throw {@link MCPRegistryConnectError} (which disconnects all servers
   * connected during the call) when any server fails.
   */
  async connectAll(options: { throwOnFailure?: boolean } = {}): Promise<MCPConnectResult[]> {
    const entries = [...this.providers.entries()];
    const settled = await Promise.allSettled(entries.map(([, p]) => p.connect()));

    const results: MCPConnectResult[] = settled.map((outcome, index) => {
      const name = entries[index][0];
      if (outcome.status === 'fulfilled') {
        return { name, status: 'fulfilled' };
      }
      return { name, status: 'rejected', reason: outcome.reason as unknown };
    });

    if (options.throwOnFailure && results.some((r) => r.status === 'rejected')) {
      await Promise.allSettled(
        entries
          .filter((_, index) => settled[index].status === 'fulfilled')
          .map(([, p]) => p.disconnect()),
      );
      throw new MCPRegistryConnectError(results);
    }

    return results;
  }

  /**
   * Disconnect all registered servers. Errors from individual providers do
   * not abort the cleanup of the others.
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.providers.values()].map((p) => p.disconnect()));
  }

  /**
   * Return all tools from connected providers, namespaced by server name.
   *
   * Tools are named `{serverName}.{mcpToolName}` (e.g. `weather.get_weather`).
   */
  getAllTools(): BaseTool[] {
    const tools: BaseTool[] = [];
    for (const provider of this.providers.values()) {
      tools.push(...provider.getTools());
    }
    return tools;
  }

  /**
   * Register all MCP tools into a {@link import('../registry.js').ToolRegistry}.
   */
  registerAll(registry: { register(tool: BaseTool): unknown }): void {
    for (const tool of this.getAllTools()) {
      registry.register(tool);
    }
  }

  /**
   * Bind the registry to a `ToolRegistry`. All current tools are registered
   * immediately, and the target is kept in sync whenever any provider emits
   * `onToolsChanged` (e.g. on `notifications/tools/list_changed`).
   *
   * @returns Unsubscribe function that detaches the synchronization.
   */
  bindTo(
    registry: {
      register(tool: BaseTool): unknown;
      unregisterNamespace(namespace: string): number;
    },
  ): () => void {
    for (const tool of this.getAllTools()) {
      registry.register(tool);
    }

    const unsubscribers: Array<() => void> = [];
    for (const [name, provider] of this.providers) {
      unsubscribers.push(
        provider.onToolsChanged((tools) => {
          registry.unregisterNamespace(name);
          for (const tool of tools) {
            registry.register(tool);
          }
        }),
      );
    }

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }
}

import type { JSONSchema, ToolMetadata } from '../../types/tools.js';
import { BaseTool, type BaseToolConfig } from '../tool.js';
import type { MCPClient } from './client.js';

/** Configuration for {@link MCPTool}. */
export interface MCPToolConfig extends BaseToolConfig {
  /** Original MCP tool name sent in `tools/call`. */
  mcpToolName: string;
  /** MCP client used for remote invocation. */
  client: MCPClient;
}

/**
 * {@link BaseTool} wrapper that delegates execution to an MCP server via `tools/call`.
 */
export class MCPTool extends BaseTool {
  private readonly mcpToolName: string;
  private readonly client: MCPClient;

  /**
   * @param config - Tool metadata plus MCP client and remote tool name.
   */
  constructor(config: MCPToolConfig) {
    super(config);
    this.mcpToolName = config.mcpToolName;
    this.client = config.client;
  }

  /** Remote MCP tool name (without registry namespace). */
  getMcpToolName(): string {
    return this.mcpToolName;
  }

  /** @inheritdoc */
  protected _execute(input: Record<string, unknown>): Promise<unknown> {
    return this.client.callTool(this.mcpToolName, input);
  }
}

/** Options for {@link createMCPTool}. */
export interface CreateMCPToolOptions {
  /** Optional namespace prefix (e.g. `weather` → `weather.get_weather`). */
  namespace?: string;
  /** Override metadata. Defaults to undefined since MCP servers vary widely. */
  metadata?: ToolMetadata;
  /** Override tool execution timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Build an {@link MCPTool} from an MCP tool definition.
 *
 * @param definition - Tool from `tools/list`.
 * @param client - Connected MCP client.
 * @param options - Optional namespace prefix, metadata overrides, and timeout.
 */
export function createMCPTool(
  definition: { name: string; description?: string; inputSchema: JSONSchema },
  client: MCPClient,
  options: CreateMCPToolOptions | string = {},
): MCPTool {
  // Backwards-compat: a string positional argument was previously the namespace.
  const opts: CreateMCPToolOptions = typeof options === 'string' ? { namespace: options } : options;
  const name = opts.namespace ? `${opts.namespace}.${definition.name}` : definition.name;

  return new MCPTool({
    name,
    mcpToolName: definition.name,
    description: definition.description ?? `MCP tool: ${definition.name}`,
    inputSchema: definition.inputSchema ?? { type: 'object', properties: {} },
    client,
    metadata: opts.metadata,
    timeoutMs: opts.timeoutMs,
  });
}

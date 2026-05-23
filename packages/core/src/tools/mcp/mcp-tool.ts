import type { ApprovalHandler, JSONSchema, ToolMetadata } from '../../types/tools.js';
import { BaseTool, type BaseToolConfig, type ToolExecutionEvents } from '../tool.js';
import type { MCPClient } from './client.js';

/**
 * Normalize an MCP `inputSchema` into a JSON Schema suitable for validation
 * and LLM tool registration.
 *
 * MCP servers often omit `type: "object"` even when `properties` are present.
 */
export function normalizeMcpInputSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  if (schema.type !== undefined) {
    return schema;
  }
  if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    return { type: 'object', ...schema };
  }
  return schema;
}

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
  /** Require human approval before execution. */
  requiresApproval?: boolean;
  /** Per-tool approval handler (overrides registry global handler). */
  approvalHandler?: ApprovalHandler;
  /** Lifecycle event hooks. */
  events?: ToolExecutionEvents;
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
    inputSchema: normalizeMcpInputSchema(definition.inputSchema),
    client,
    metadata: opts.metadata,
    timeoutMs: opts.timeoutMs,
    requiresApproval: opts.requiresApproval,
    approvalHandler: opts.approvalHandler,
    events: opts.events,
  });
}

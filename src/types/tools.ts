/**
 * Supported JSON Schema primitive and composite types (simplified subset).
 */
export type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * Simplified JSON Schema definition for tool input validation.
 *
 * Covers the common subset used for LLM tool calling without external schema libraries.
 */
export interface JSONSchema {
  /** Primary type of the value. */
  type?: JSONSchemaType | JSONSchemaType[];
  /** Human-readable description shown to the model. */
  description?: string;
  /** Allowed enum values. */
  enum?: unknown[];
  /** Default value when the property is omitted. */
  default?: unknown;
  /** Object property schemas keyed by name. */
  properties?: Record<string, JSONSchema>;
  /** Required property names when `type` is `object`. */
  required?: string[];
  /** Schema for array items. */
  items?: JSONSchema | JSONSchema[];
  /** Whether additional object properties are allowed. */
  additionalProperties?: boolean | JSONSchema;
  /** String minimum length. */
  minLength?: number;
  /** String maximum length. */
  maxLength?: number;
  /** Numeric minimum (inclusive). */
  minimum?: number;
  /** Numeric maximum (inclusive). */
  maximum?: number;
  /** Regex pattern for strings. */
  pattern?: string;
  /** String format hint (e.g. `email`, `date-time`). */
  format?: string;
  /** JSON Schema `$ref` pointer (document-relative). */
  $ref?: string;
  /** Exactly one sub-schema must match. */
  oneOf?: JSONSchema[];
  /** At least one sub-schema must match. */
  anyOf?: JSONSchema[];
  /** All sub-schemas must match. */
  allOf?: JSONSchema[];
}

/**
 * Operational hints about a tool for routing, budgeting, and safety policies.
 */
export interface ToolMetadata {
  /** Relative cost tier of invoking this tool. */
  cost?: 'free' | 'low' | 'medium' | 'high';
  /** Expected latency class. */
  latency?: 'fast' | 'medium' | 'slow';
  /** Whether credentials or user session are required. */
  requiresAuth?: boolean;
  /** Side-effect classification for policy enforcement. @defaultValue 'none' */
  sideEffect?: 'none' | 'read' | 'write' | 'destructive';
  /** Whether repeated calls with the same input are safe. @defaultValue false */
  idempotent?: boolean;
  /** When truthy, execution requires human approval via an {@link ApprovalHandler}. @defaultValue false */
  requiresApproval?: boolean | ApprovalRequirement;
  /** When true, execution requires an available sandbox. @defaultValue false */
  requiresSandbox?: boolean;
  /** Controls which input fields are logged for audit. */
  audit?: AuditConfig;
  /** Semantic version of the tool definition. */
  version?: string;
}

/** Policy metadata describing who must approve a gated tool. */
export interface ApprovalRequirement {
  /** Required role for the approver. */
  role?: string;
  /** Number of approvals needed. @defaultValue 1 */
  multi?: number;
  /** Input fields that constitute the approval scope. */
  scopes?: string[];
}

/** Controls which input fields appear in tool audit logs. */
export interface AuditConfig {
  /** Input fields to include in the audit log (all others omitted). */
  include?: string[];
  /** Input fields to redact from the audit log. */
  exclude?: string[];
}

/** Safety envelope returned by {@link import('../tools/registry.js').ToolRegistry.toolDescriptors}. */
export interface ToolDescriptorSafety {
  sideEffect: string;
  idempotent: boolean;
  requiresApproval: boolean | ApprovalRequirement;
  requiresSandbox: boolean;
}

/** Complete tool descriptor for UIs, policy engines, and documentation. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  safety: ToolDescriptorSafety;
  version?: string;
}

/** Emitted after a tool executes when {@link AuditConfig} is configured. */
export interface ToolAuditEvent {
  timestamp: string;
  toolName: string;
  agentName?: string;
  success: boolean;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

/** Context passed to an approval handler before a gated tool runs. */
export interface ApprovalRequest {
  /** Registered tool name. */
  toolName: string;
  /** Proposed tool arguments from the model. */
  input: Record<string, unknown>;
  /** Agent requesting execution. */
  agentName: string;
  /** Current ReAct step index. */
  stepNumber: number;
  /** Optional extra context for the approver. */
  context?: string;
}

/** Human or policy decision for a gated tool call. */
export interface ApprovalResponse {
  /** Whether the tool may run. */
  approved: boolean;
  /** Optional replacement input when approved with edits. */
  modifiedInput?: Record<string, unknown>;
  /** Optional denial or approval note. */
  reason?: string;
}

/**
 * Decides whether a tool requiring approval may execute.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalResponse>;

/** Optional context when executing a tool through {@link import('../tools/registry.js').ToolRegistry}. */
export interface ToolExecuteOptions {
  /** Agent name for approval requests. @defaultValue `"agent"` */
  agentName?: string;
  /** ReAct step number for approval requests. @defaultValue `0` */
  stepNumber?: number;
  /** Extra context shown to the approval handler. */
  context?: string;
  /** Skip destructive-tool safety middleware (internal framework use). @defaultValue false */
  skipSafetyChecks?: boolean;
}

/**
 * Declarative description of a tool exposed to a completion provider.
 */
export interface ToolDefinition<TMeta extends ToolMetadata = ToolMetadata> {
  /** Unique tool name referenced in tool-use content blocks. */
  name: string;
  /** Natural-language description for the model. */
  description: string;
  /** JSON Schema describing the tool's input object. */
  inputSchema: JSONSchema;
  /** Optional routing and policy metadata. */
  metadata?: TMeta;
}

/**
 * Structured failure metadata attached to a {@link ToolResult}.
 *
 * Populated by {@link import('../tools/tool.js').BaseTool.execute} from the
 * thrown error. Carries protocol-level codes (e.g. JSON-RPC `-32601`) and
 * arbitrary `data` payloads so callers can branch without parsing strings.
 */
export interface ToolErrorDetails {
  /** Error class name (e.g. `MCPProtocolError`, `ToolValidationError`). */
  name: string;
  /** Numeric error code if the error carries one. */
  code?: number;
  /** Additional structured payload from the error. */
  data?: unknown;
}

/**
 * Outcome of a single tool execution.
 *
 * @typeParam TOutput - Successful return payload type.
 */
export interface ToolResult<TOutput = unknown> {
  /** Whether execution completed without error. */
  success: boolean;
  /** Structured or primitive result on success. */
  output: TOutput;
  /** Human-readable error message when `success` is false. */
  error?: string;
  /** Structured error metadata (preserved error class name, code, data). */
  errorDetails?: ToolErrorDetails;
}

/**
 * Runtime executor for a registered tool.
 *
 * @typeParam TInput - Validated input shape (defaults to open object).
 * @typeParam TOutput - Successful output shape.
 */
export interface ToolExecutor<TInput = Record<string, unknown>, TOutput = unknown> {
  /**
   * Run the tool with model-supplied arguments.
   *
   * @param input - Arguments matching the tool's {@link ToolDefinition.inputSchema}.
   */
  execute(input: TInput): Promise<ToolResult<TOutput>>;
}

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
  /** Whether repeated calls with the same input are safe. */
  idempotent?: boolean;
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

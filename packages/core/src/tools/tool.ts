import type {
  ApprovalHandler,
  JSONSchema,
  ToolErrorDetails,
  ToolMetadata,
  ToolResult,
} from '../types/tools.js';
import { validateSchema } from '../utils/schema-validator.js';

function requiresApprovalEnabled(value?: ToolMetadata['requiresApproval']): boolean {
  return value !== undefined && value !== false;
}

function normalizeToolMetadata(metadata?: ToolMetadata): ToolMetadata {
  return {
    sideEffect: 'none',
    idempotent: false,
    requiresApproval: false,
    requiresSandbox: false,
    ...metadata,
  };
}

/** Default tool execution timeout in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Events emitted during tool execution lifecycle.
 */
export interface ToolExecutionEvents {
  /** Fired before validation and execution begin. */
  onStart?: (event: ToolExecutionEvent) => void;
  /** Fired after successful execution. */
  onComplete?: (event: ToolExecutionResultEvent) => void;
  /** Fired when validation or execution fails. */
  onError?: (event: ToolExecutionErrorEvent) => void;
}

/** Payload for `onStart`. */
export interface ToolExecutionEvent {
  /** Tool name. */
  name: string;
  /** Raw input passed to {@link BaseTool.execute}. */
  input: Record<string, unknown>;
}

/** Payload for `onComplete`. */
export interface ToolExecutionResultEvent extends ToolExecutionEvent {
  /** Structured execution result. */
  result: ToolResult;
}

/** Payload for `onError`. */
export interface ToolExecutionErrorEvent extends ToolExecutionEvent {
  /** Failure stage. */
  stage: 'validation' | 'execution';
  /** Error instance (validation failures use `ToolValidationError`). */
  error: Error;
}

/** Error thrown for input schema validation failures. */
export class ToolValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'ToolValidationError';
    this.errors = errors;
  }
}

/**
 * Extract {@link ToolErrorDetails} from any thrown value.
 *
 * Picks up `code` and `data` properties when present (covers MCP errors,
 * Node.js error codes, and any custom error class). Always returns a `name`.
 */
export function extractErrorDetails(error: unknown): ToolErrorDetails {
  if (error instanceof ToolValidationError) {
    return {
      name: error.name,
      data: { errors: error.errors },
    };
  }

  if (error instanceof Error && error.name === 'MCPToolError') {
    const mcp = error as Error & { result?: unknown; content?: unknown };
    const details: ToolErrorDetails = { name: error.name };
    if (mcp.result !== undefined || mcp.content !== undefined) {
      details.data = { result: mcp.result, content: mcp.content };
    }
    return details;
  }

  if (!(error instanceof Error)) {
    return { name: typeof error };
  }

  const record = error as unknown as { code?: unknown; data?: unknown };
  const details: ToolErrorDetails = { name: error.name || 'Error' };
  if (typeof record.code === 'number') {
    details.code = record.code;
  }
  if (record.data !== undefined) {
    details.data = record.data;
  }
  return details;
}

/**
 * Configuration shared by {@link BaseTool} subclasses.
 */
export interface BaseToolConfig {
  /** Unique tool name (may include namespaces, e.g. `weather.lookup`). */
  name: string;
  /** Natural-language description for the model. */
  description: string;
  /** JSON Schema for validating tool input. */
  inputSchema: JSONSchema;
  /** Optional operational metadata. */
  metadata?: ToolMetadata;
  /** Require human approval before execution (also set via `metadata.requiresApproval`). */
  requiresApproval?: boolean;
  /** Per-tool approval handler (overrides registry global handler). */
  approvalHandler?: ApprovalHandler;
  /** Execution timeout in milliseconds. @defaultValue 30000 */
  timeoutMs?: number;
  /** Lifecycle event hooks. */
  events?: ToolExecutionEvents;
}

/**
 * Abstract base class for agent tools with validation, timeouts, and structured results.
 */
export abstract class BaseTool {
  /** Unique tool name. */
  readonly name: string;

  /** Model-facing description. */
  readonly description: string;

  /** Input JSON Schema. */
  readonly inputSchema: JSONSchema;

  /** Optional metadata for routing and policies. */
  readonly metadata?: ToolMetadata;

  /** Whether this tool requires approval before execution. */
  readonly requiresApproval: boolean;

  /** Optional per-tool approval handler. */
  readonly approvalHandler?: ApprovalHandler;

  private readonly timeoutMs: number;
  protected readonly events: ToolExecutionEvents;

  /**
   * @param config - Tool identity, schema, and execution options.
   */
  constructor(config: BaseToolConfig) {
    this.name = config.name;
    this.description = config.description;
    this.inputSchema = config.inputSchema;
    const metadata = config.metadata ? normalizeToolMetadata(config.metadata) : undefined;
    const requiresApprovalFlag =
      config.requiresApproval === true || requiresApprovalEnabled(metadata?.requiresApproval);
    this.metadata =
      metadata || config.requiresApproval === true
        ? normalizeToolMetadata({
            ...metadata,
            ...(config.requiresApproval === true ? { requiresApproval: true } : {}),
          })
        : undefined;
    this.requiresApproval = requiresApprovalFlag;
    this.approvalHandler = config.approvalHandler;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.events = config.events ?? {};
  }

  /**
   * Vendor-specific tool implementation.
   *
   * @param input - Validated input object.
   */
  protected abstract _execute(input: Record<string, unknown>): Promise<unknown>;

  /**
   * Validate input, run {@link _execute} with a timeout, and return a {@link ToolResult}.
   *
   * @param input - Raw tool arguments from the model.
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    this.events.onStart?.({ name: this.name, input });

    const validation = validateSchema(this.inputSchema, input);
    if (!validation.valid) {
      const validationError = new ToolValidationError(validation.errors);
      const result: ToolResult = {
        success: false,
        output: null,
        error: validationError.message,
        errorDetails: extractErrorDetails(validationError),
      };
      this.events.onError?.({
        name: this.name,
        input,
        stage: 'validation',
        error: validationError,
      });
      return result;
    }

    try {
      const output = await this.runWithTimeout(() => this._execute(input));
      const result: ToolResult = { success: true, output };
      this.events.onComplete?.({ name: this.name, input, result });
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const result: ToolResult = {
        success: false,
        output: null,
        error: normalized.message,
        errorDetails: extractErrorDetails(normalized),
      };
      this.events.onError?.({ name: this.name, input, stage: 'execution', error: normalized });
      return result;
    }
  }

  /** Convert to {@link import('../types/tools.js').ToolDefinition} for LLM registration. */
  toDefinition(): {
    name: string;
    description: string;
    inputSchema: JSONSchema;
    metadata?: ToolMetadata;
  } {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      metadata: this.metadata,
    };
  }

  /** Run `fn` with an execution timeout. */
  protected runWithTimeout(fn: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool "${this.name}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      fn()
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

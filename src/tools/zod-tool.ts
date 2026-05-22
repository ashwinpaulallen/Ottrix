import type { ZodType, ZodTypeAny } from 'zod';
import type { ToolMetadata, ToolResult } from '../types/tools.js';
import { invokeWithRunContext, type RunContext } from '../context/run-context.js';
import { zodToJsonSchema } from '../utils/zod-to-json-schema.js';
import {
  BaseTool,
  ToolValidationError,
  extractErrorDetails,
  type ToolExecutionEvents,
} from './tool.js';

/** Configuration for {@link ZodTool}. */
export interface ZodToolConfig<TInput, TOutput = unknown> {
  /** Unique tool name. */
  name: string;
  /** Model-facing description. */
  description: string;
  /** Zod schema for validating and typing tool input. */
  input: ZodType<TInput>;
  /** Optional Zod schema for validating tool output. */
  output?: ZodType<TOutput>;
  /** Typed implementation invoked after input validation. */
  execute: ((input: TInput) => Promise<TOutput>) | ((input: TInput, ctx: RunContext | undefined) => Promise<TOutput>);
  /** Optional operational metadata. */
  metadata?: ToolMetadata;
  /** Execution timeout in milliseconds. */
  timeoutMs?: number;
  /** Lifecycle event hooks. */
  events?: ToolExecutionEvents;
}

/**
 * Tool implementation with Zod input/output validation and typed `execute`.
 *
 * Converts the input schema to JSON Schema for LLM tool registration via {@link zodToJsonSchema}.
 */
export class ZodTool<TInput, TOutput = unknown> extends BaseTool {
  /** Original Zod input schema (for programmatic use). */
  readonly zodSchema: ZodType<TInput>;

  /** Optional Zod output schema. */
  readonly zodOutputSchema?: ZodType<TOutput>;

  private readonly executeFn: (
    input: TInput,
    ctx?: RunContext,
  ) => Promise<TOutput>;

  /**
   * @param config - Tool metadata, Zod schemas, and typed executor.
   */
  constructor(config: ZodToolConfig<TInput, TOutput>) {
    super({
      name: config.name,
      description: config.description,
      inputSchema: zodToJsonSchema(config.input),
      metadata: config.metadata,
      timeoutMs: config.timeoutMs,
      events: config.events,
    });
    this.zodSchema = config.input;
    this.zodOutputSchema = config.output;
    this.executeFn = config.execute;
  }

  /** @inheritdoc — validates with Zod instead of JSON Schema. */
  override async execute(input: Record<string, unknown>): Promise<ToolResult> {
    this.events.onStart?.({ name: this.name, input });

    const parsedInput = this.zodSchema.safeParse(input);
    if (!parsedInput.success) {
      return this.validationFailureResult(parsedInput.error, 'input', input);
    }

    try {
      const rawOutput = await this.runWithTimeout(() =>
        invokeWithRunContext(this.executeFn, parsedInput.data),
      );

      if (this.zodOutputSchema) {
        const parsedOutput = this.zodOutputSchema.safeParse(rawOutput);
        if (!parsedOutput.success) {
          return this.validationFailureResult(parsedOutput.error, 'output', input);
        }
        const result: ToolResult<TOutput> = { success: true, output: parsedOutput.data };
        this.events.onComplete?.({ name: this.name, input, result });
        return result;
      }

      const result: ToolResult = { success: true, output: rawOutput };
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

  /** @inheritdoc */
  protected _execute(_input: Record<string, unknown>): Promise<unknown> {
    throw new Error('ZodTool validates in execute(); _execute is not used.');
  }

  private validationFailureResult(
    error: { issues: { path: PropertyKey[]; message: string }[] },
    stage: 'input' | 'output',
    input: Record<string, unknown>,
  ): ToolResult {
    const messages = formatZodIssues(error.issues);
    const validationError = new ToolValidationError(messages);
    const result: ToolResult = {
      success: false,
      output: null,
      error: validationError.message,
      errorDetails: {
        name: validationError.name,
        data: { stage, errors: messages, issues: error.issues },
      },
    };
    this.events.onError?.({
      name: this.name,
      input,
      stage: 'validation',
      error: validationError,
    });
    return result;
  }
}

/**
 * Create a {@link ZodTool} with typed input/output (recommended API for new tools).
 */
export function createTool<TInput, TOutput = unknown>(
  config: ZodToolConfig<TInput, TOutput>,
): ZodTool<TInput, TOutput> {
  return new ZodTool(config);
}

/** Whether a tool was created with a Zod input schema. */
export function isZodTool(tool: BaseTool): tool is ZodTool<unknown, unknown> {
  return tool instanceof ZodTool;
}

function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/** @internal Type used by {@link import('./registry.js').ToolRegistry.getZodSchema}. */
export type AnyZodSchema = ZodTypeAny;

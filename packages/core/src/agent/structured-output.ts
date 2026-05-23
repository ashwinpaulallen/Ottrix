import type { ZodError, ZodTypeAny } from 'zod';
import { ZodError as ZodErrorClass } from 'zod';
import type { JSONSchema } from '../types/tools.js';
import { zodToJsonSchema } from '../utils/zod-to-json-schema.js';

/** Error thrown when structured output validation fails after all retries. */
export class StructuredOutputError extends Error {
  readonly name = 'StructuredOutputError';

  /**
   * @param message - Human-readable summary.
   * @param rawOutput - Last model text before parsing/validation failed.
   * @param zodErrors - Zod validation error from the final attempt.
   * @param attempts - Total validation attempts made (initial + retries).
   */
  constructor(
    message: string,
    readonly rawOutput: string,
    readonly zodErrors: ZodError,
    readonly attempts: number,
  ) {
    super(message);
  }
}

export interface StructuredOutputContext {
  schema: ZodTypeAny;
  jsonSchema: JSONSchema;
  /** Total validation attempts (1 initial + {@link structuredOutputRetries}). */
  maxAttempts: number;
  attempts: number;
  lastZodError?: ZodError;
  lastRawOutput?: string;
  /** When true, provider adapters may enable native JSON response mode. */
  preferJsonResponseFormat: boolean;
}

/**
 * Resolve total validation attempts from a retry count.
 * `structuredOutputRetries` is the number of re-prompts after the first failed validation.
 */
export function resolveStructuredOutputMaxAttempts(retries?: number): number {
  const retryCount = retries ?? 3;
  if (!Number.isFinite(retryCount) || retryCount < 0) {
    return 4;
  }
  return 1 + Math.floor(retryCount);
}

/** Build runtime context for a structured output run. */
export function createStructuredOutputContext(
  schema: ZodTypeAny,
  structuredOutputRetries: number | undefined,
  preferJsonResponseFormat: boolean,
): StructuredOutputContext {
  return {
    schema,
    jsonSchema: zodToJsonSchema(schema),
    maxAttempts: resolveStructuredOutputMaxAttempts(structuredOutputRetries),
    attempts: 0,
    preferJsonResponseFormat,
  };
}

/** System-prompt suffix instructing the model to emit schema-conformant JSON for the final answer. */
export function buildStructuredOutputInstruction(jsonSchema: JSONSchema): string {
  const schemaJson = JSON.stringify(jsonSchema, null, 2);
  return [
    'When you are ready to give your final answer to the user (not when invoking tools),',
    'you MUST respond with a JSON object matching this schema:',
    '```json',
    schemaJson,
    '```',
    'Respond with ONLY the JSON object, no markdown fences, no explanation.',
    'You may still use tools for intermediate steps before producing that final JSON answer.',
  ].join('\n');
}

/** Append structured-output instructions to an optional base system prompt. */
export function appendStructuredOutputToSystemPrompt(
  basePrompt: string | undefined,
  jsonSchema: JSONSchema,
): string {
  const instruction = buildStructuredOutputInstruction(jsonSchema);
  if (!basePrompt?.trim()) {
    return instruction;
  }
  return `${basePrompt.trim()}\n\n${instruction}`;
}

/**
 * Extract JSON payload text from a model response.
 * Handles full/embedded markdown fences and JSON surrounded by prose.
 */
export function extractStructuredJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const fullFence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fullFence?.[1]) {
    return fullFence[1].trim();
  }

  const embeddedFence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (embeddedFence?.[1]) {
    return embeddedFence[1].trim();
  }

  const objectSlice = sliceBalancedJson(trimmed, '{', '}');
  if (objectSlice) {
    return objectSlice;
  }

  const arraySlice = sliceBalancedJson(trimmed, '[', ']');
  if (arraySlice) {
    return arraySlice;
  }

  return trimmed;
}

/** @deprecated Use {@link extractStructuredJsonText}. */
export function stripMarkdownJsonFences(text: string): string {
  return extractStructuredJsonText(text);
}

/** Parse model text as JSON, throwing a descriptive error on failure. */
export function parseStructuredJsonText(text: string): unknown {
  const candidate = extractStructuredJsonText(text);
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Failed to parse structured output as JSON: ${detail}`);
    if (error instanceof Error) {
      wrapped.cause = error;
    }
    throw wrapped;
  }
}

export type StructuredOutputParseResult =
  | { success: true; data: unknown }
  | { success: false; kind: 'json'; error: Error }
  | { success: false; kind: 'zod'; error: ZodError; parsed: unknown };

/**
 * Parse and validate model text against a Zod schema.
 */
export function parseAndValidateStructuredOutput(
  text: string,
  schema: ZodTypeAny,
): StructuredOutputParseResult {
  let parsed: unknown;
  try {
    parsed = parseStructuredJsonText(text);
  } catch (error) {
    return {
      success: false,
      kind: 'json',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, kind: 'zod', error: result.error, parsed };
}

function isZodError(error: ZodError | Error): error is ZodError {
  return error instanceof ZodErrorClass;
}

/** User message appended when structured output validation fails. */
export function buildStructuredOutputRetryMessage(errors: ZodError | Error): string {
  const detail = isZodError(errors) ? formatZodIssues(errors) : errors.message;
  return `Your response didn't match the required schema. Errors: ${detail}. Please try again.`;
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function sliceBalancedJson(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

import { validateSchema } from '../utils/schema-validator.js';
import type { JSONSchema } from '../types/tools.js';
import type { ValidationResult, Validator } from '../types/guardrails.js';
import { completionText } from './middleware.js';
import type { GuardrailDecision, GuardrailHandler, LlmGuardrailContext } from './types.js';

const PII_PATTERNS = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  phone: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/,
} as const;

const REDACTED = '[REDACTED]';

/** Mode for {@link PiiDetector}. */
export type PiiMode = 'detect' | 'redact';

/** Options for {@link PiiDetector}. */
export interface PiiDetectorOptions {
  mode?: PiiMode;
  /** When true, `block` on detection instead of only flagging. */
  blockOnDetect?: boolean;
}

/** Regex-based PII detection for emails, phones, SSNs, and credit card numbers. */
export class PiiDetector implements Validator, GuardrailHandler {
  readonly name = 'pii-detector';
  private readonly mode: PiiMode;
  private readonly blockOnDetect: boolean;

  constructor(options: PiiDetectorOptions = {}) {
    this.mode = options.mode ?? 'detect';
    this.blockOnDetect = options.blockOnDetect ?? false;
  }

  /** Whether this detector rewrites content instead of only flagging. */
  redactsContent(): boolean {
    return this.mode === 'redact';
  }

  validate(content: string): Promise<ValidationResult> {
    const findings = detectPii(content);
    if (findings.length === 0) {
      return Promise.resolve({ passed: true });
    }

    if (this.mode === 'redact') {
      return Promise.resolve({
        passed: true,
        reason: `PII redacted: ${findings.join(', ')}`,
        severity: 'warning',
      });
    }

    return Promise.resolve({
      passed: !this.blockOnDetect,
      reason: `PII detected: ${findings.join(', ')}`,
      severity: this.blockOnDetect ? 'error' : 'warning',
    });
  }

  afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (!context.result) {
      return Promise.resolve();
    }

    const text = completionText(context.result);
    const findings = detectPii(text);
    if (findings.length === 0) {
      return Promise.resolve();
    }

    if (this.mode === 'redact') {
      return Promise.resolve({
        action: 'modify',
        modifiedText: redactPii(text),
        flags: findings.map((f) => `pii:${f}`),
      });
    }

    if (this.blockOnDetect) {
      return Promise.resolve({
        action: 'block',
        reason: `PII detected in model output: ${findings.join(', ')}`,
      });
    }

    return Promise.resolve({
      action: 'flag',
      flags: findings.map((f) => `pii:${f}`),
      reason: `PII detected: ${findings.join(', ')}`,
    });
  }
}

/** Block or flag content matching configurable patterns. */
export class ContentFilter implements Validator, GuardrailHandler {
  readonly name: string;
  private readonly patterns: RegExp[];
  private readonly action: 'block' | 'flag';

  constructor(options: {
    patterns: Array<string | RegExp>;
    action?: 'block' | 'flag';
    name?: string;
  }) {
    this.name = options.name ?? 'content-filter';
    this.patterns = options.patterns.map((p) => (typeof p === 'string' ? new RegExp(p, 'i') : p));
    this.action = options.action ?? 'block';
  }

  validate(content: string): Promise<ValidationResult> {
    const match = this.findMatch(content);
    if (!match) {
      return Promise.resolve({ passed: true });
    }

    return Promise.resolve({
      passed: this.action === 'flag',
      reason: `Content matched blocked pattern: ${match}`,
      severity: this.action === 'block' ? 'error' : 'warning',
    });
  }

  afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (!context.result) {
      return Promise.resolve();
    }

    const text = completionText(context.result);
    const match = this.findMatch(text);
    if (!match) {
      return Promise.resolve();
    }

    if (this.action === 'block') {
      return Promise.resolve({
        action: 'block',
        reason: `Response matched blocked pattern: ${match}`,
      });
    }

    return Promise.resolve({ action: 'flag', reason: `Response matched pattern: ${match}` });
  }

  private findMatch(content: string): string | undefined {
    for (const pattern of this.patterns) {
      const hit = pattern.exec(content);
      pattern.lastIndex = 0;
      if (hit) {
        return hit[0];
      }
    }
    return undefined;
  }
}

/** Ensure agent output JSON matches a required schema. */
export class SchemaValidator implements Validator, GuardrailHandler {
  readonly name = 'schema-validator';

  constructor(private readonly schema: JSONSchema) {}

  validate(content: string): Promise<ValidationResult> {
    const parsed = tryParseJson(content);
    if (parsed.error) {
      return Promise.resolve({
        passed: false,
        reason: parsed.error,
        severity: 'error',
      });
    }

    const result = validateSchema(this.schema, parsed.value);
    return Promise.resolve({
      passed: result.valid,
      reason: result.valid ? undefined : result.errors.join('; '),
      severity: result.valid ? undefined : 'error',
    });
  }

  async afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (!context.result) {
      return;
    }

    const validation = await this.validate(completionText(context.result));
    if (validation.passed) {
      return;
    }

    return {
      action: 'block',
      reason: validation.reason ?? 'Output failed schema validation',
    };
  }
}

/** Reject outputs exceeding a character or estimated token limit. */
export class MaxLengthValidator implements Validator, GuardrailHandler {
  readonly name = 'max-length';

  constructor(
    private readonly options: {
      maxCharacters?: number;
      maxTokens?: number;
      /** Chars per token when `maxTokens` is set without a provider. @defaultValue 4 */
      charsPerToken?: number;
    },
  ) {}

  validate(content: string): Promise<ValidationResult> {
    const { maxCharacters, maxTokens, charsPerToken = 4 } = this.options;

    if (maxCharacters !== undefined && content.length > maxCharacters) {
      return Promise.resolve({
        passed: false,
        reason: `Output length ${content.length} exceeds max ${maxCharacters} characters`,
        severity: 'error',
      });
    }

    if (maxTokens !== undefined) {
      const estimated = Math.ceil(content.length / charsPerToken);
      if (estimated > maxTokens) {
        return Promise.resolve({
          passed: false,
          reason: `Estimated ${estimated} tokens exceeds max ${maxTokens}`,
          severity: 'error',
        });
      }
    }

    return Promise.resolve({ passed: true });
  }

  async afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (!context.result) {
      return;
    }

    const validation = await this.validate(completionText(context.result));
    if (validation.passed) {
      return;
    }

    return {
      action: 'block',
      reason: validation.reason ?? 'Output exceeds length limit',
    };
  }
}

/** Detect PII categories present in text. */
export function detectPii(text: string): string[] {
  const found: string[] = [];
  for (const [label, pattern] of Object.entries(PII_PATTERNS)) {
    if (pattern.test(text)) {
      found.push(label);
    }
  }
  return found;
}

/** Replace detected PII with `[REDACTED]`. */
export function redactPii(text: string): string {
  let result = text;
  for (const pattern of Object.values(PII_PATTERNS)) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  return result;
}

function tryParseJson(content: string): { value: unknown; error?: string } {
  const trimmed = content.trim();
  const jsonSlice = extractJsonBlock(trimmed) ?? trimmed;

  try {
    return { value: JSON.parse(jsonSlice) as unknown };
  } catch {
    return { value: undefined, error: 'Output is not valid JSON' };
  }
}

function extractJsonBlock(text: string): string | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) {
    return fence[1].trim();
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return undefined;
}

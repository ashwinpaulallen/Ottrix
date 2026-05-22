import { extractTextFromContent } from '../agent/messages.js';
import type { CompletionProvider, CompletionResult, TokenUsage } from '../types/provider.js';
import type { ScoreResult } from './types.js';
import type { ZodTypeAny } from 'zod';

/** A function that scores an agent output against optional expectations. */
export interface Scorer {
  name: string;
  score(
    input: string,
    output: string,
    expected?: string,
    metadata?: Record<string, unknown>,
  ): Promise<ScoreResult>;
}

/** Clamp a value to the inclusive range [0, 1]. */
export function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Extract JSON from raw model output or markdown fences. */
export function extractJsonCandidate(output: string): string {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return (fenced ?? output).trim();
}

/** Score is 1 when output exactly matches expected, else 0. */
export class ExactMatchScorer implements Scorer {
  readonly name = 'exact_match';

  constructor(private readonly trim = false) {}

  async score(_input: string, output: string, expected?: string): Promise<ScoreResult> {
    if (expected === undefined) {
      return { score: 0, reason: 'No expected output provided' };
    }
    const actual = this.trim ? output.trim() : output;
    const reference = this.trim ? expected.trim() : expected;
    const match = actual === reference;
    return { score: match ? 1 : 0, reason: match ? 'Exact match' : 'Output differs from expected' };
  }
}

/** Score is the fraction of keywords found in the output (case-insensitive). */
export class ContainsScorer implements Scorer {
  readonly name: string;
  private readonly keywords: string[];

  constructor(keywords: string[]) {
    this.keywords = keywords.filter((keyword) => keyword.length > 0);
    this.name = `contains(${this.keywords.join(',')})`;
  }

  async score(_input: string, output: string): Promise<ScoreResult> {
    if (this.keywords.length === 0) {
      return { score: 0, reason: 'No keywords configured' };
    }

    const haystack = output.toLowerCase();
    const found = this.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
    const score = clampScore(found.length / this.keywords.length);

    return {
      score,
      reason: `Matched ${found.length}/${this.keywords.length} keywords`,
      metadata: { found, missing: this.keywords.filter((keyword) => !found.includes(keyword)) },
    };
  }
}

/** Score is 1 when output parses as JSON, else 0. */
export class JsonValidityScorer implements Scorer {
  readonly name = 'json_validity';

  async score(_input: string, output: string): Promise<ScoreResult> {
    try {
      JSON.parse(extractJsonCandidate(output));
      return { score: 1, reason: 'Valid JSON' };
    } catch (error) {
      return {
        score: 0,
        reason: error instanceof Error ? error.message : 'Invalid JSON',
      };
    }
  }
}

/** Score is 1 when output JSON validates against a Zod schema, else 0. */
export class SchemaMatchScorer implements Scorer {
  readonly name: string;

  constructor(private readonly schema: ZodTypeAny) {
    this.name = `schema_match(${schema.description ?? 'schema'})`;
  }

  async score(_input: string, output: string): Promise<ScoreResult> {
    try {
      const parsed = JSON.parse(extractJsonCandidate(output));
      const result = this.schema.safeParse(parsed);
      if (result.success) {
        return { score: 1, reason: 'Schema validation passed' };
      }
      return {
        score: 0,
        reason: result.error.message,
        metadata: { issues: result.error.issues },
      };
    } catch (error) {
      return {
        score: 0,
        reason: error instanceof Error ? error.message : 'Failed to parse JSON',
      };
    }
  }
}

/** Score is 1 when output length is within range, else proportional to the nearest bound. */
export class LengthScorer implements Scorer {
  readonly name: string;

  constructor(
    private readonly min?: number,
    private readonly max?: number,
  ) {
    const resolvedMin = min ?? 0;
    const resolvedMax = max ?? Number.POSITIVE_INFINITY;
    if (resolvedMin > resolvedMax) {
      throw new Error(`LengthScorer min (${resolvedMin}) must be <= max (${resolvedMax})`);
    }
    this.name = `length(${min ?? '∞'}-${max ?? '∞'})`;
  }

  async score(_input: string, output: string): Promise<ScoreResult> {
    const length = output.length;
    const min = this.min ?? 0;
    const max = this.max ?? Number.POSITIVE_INFINITY;

    if (length >= min && length <= max) {
      return { score: 1, reason: `Length ${length} within [${min}, ${max}]` };
    }

    if (length < min) {
      const score = min === 0 ? 0 : clampScore(length / min);
      return { score, reason: `Length ${length} below minimum ${min}` };
    }

    const score = clampScore(max / length);
    return { score, reason: `Length ${length} above maximum ${max}` };
  }
}

/** Score decreases linearly as latency approaches maxMs. Expects metadata.durationMs. */
export class LatencyScorer implements Scorer {
  readonly name: string;

  constructor(private readonly maxMs: number) {
    if (maxMs <= 0) {
      throw new Error('LatencyScorer maxMs must be > 0');
    }
    this.name = `latency(${maxMs}ms)`;
  }

  async score(
    _input: string,
    _output: string,
    _expected?: string,
    metadata?: Record<string, unknown>,
  ): Promise<ScoreResult> {
    const durationMs = typeof metadata?.durationMs === 'number' ? metadata.durationMs : 0;
    const score = clampScore(1 - durationMs / this.maxMs);
    return {
      score,
      reason: `Duration ${durationMs}ms vs max ${this.maxMs}ms`,
      metadata: { durationMs },
    };
  }
}

/** Score is 1 when the regex matches the output, else 0. */
export class RegexScorer implements Scorer {
  readonly name: string;
  private readonly pattern: RegExp;

  constructor(pattern: RegExp) {
    this.pattern = new RegExp(pattern.source, pattern.flags.replace(/g/g, ''));
    this.name = `regex(${pattern.source})`;
  }

  async score(_input: string, output: string): Promise<ScoreResult> {
    const match = this.pattern.test(output);
    return {
      score: match ? 1 : 0,
      reason: match ? 'Pattern matched' : 'Pattern did not match',
    };
  }
}

/** Per-token cost rates keyed by provider name. */
export interface CostPerTokenRates {
  inputPerToken: number;
  outputPerToken: number;
}

/** Tracks token efficiency; expects metadata.tokenUsage. Computed primarily for aggregates. */
export class TokenUsageScorer implements Scorer {
  readonly name: string;

  constructor(private readonly maxTotalTokens?: number) {
    this.name =
      maxTotalTokens !== undefined ? `token_usage(${maxTotalTokens})` : 'token_usage';
  }

  async score(
    _input: string,
    _output: string,
    _expected?: string,
    metadata?: Record<string, unknown>,
  ): Promise<ScoreResult> {
    const tokenUsage = metadata?.tokenUsage as TokenUsage | undefined;
    const totalTokens = tokenUsage?.totalTokens ?? 0;

    if (this.maxTotalTokens === undefined) {
      return {
        score: 1,
        reason: 'Token usage recorded',
        metadata: { tokenUsage, totalTokens },
      };
    }

    const score = clampScore(1 - totalTokens / this.maxTotalTokens);
    return {
      score,
      reason: `${totalTokens} tokens vs max ${this.maxTotalTokens}`,
      metadata: { tokenUsage, totalTokens },
    };
  }
}

/** Estimates monetary cost from token usage; expects metadata.tokenUsage and metadata.provider. */
export class CostScorer implements Scorer {
  readonly name: string;

  constructor(
    private readonly costPerTokenByProvider: Record<string, CostPerTokenRates>,
    private readonly maxCostUsd = 1,
  ) {
    if (maxCostUsd <= 0) {
      throw new Error('CostScorer maxCostUsd must be > 0');
    }
    this.name = `cost(${maxCostUsd})`;
  }

  async score(
    _input: string,
    _output: string,
    _expected?: string,
    metadata?: Record<string, unknown>,
  ): Promise<ScoreResult> {
    const tokenUsage = metadata?.tokenUsage as TokenUsage | undefined;
    const provider = typeof metadata?.provider === 'string' ? metadata.provider : 'default';
    const rates = this.costPerTokenByProvider[provider] ?? this.costPerTokenByProvider.default;

    if (!tokenUsage || !rates) {
      return { score: 0, reason: 'Missing token usage or provider cost rates' };
    }

    const costUsd =
      tokenUsage.inputTokens * rates.inputPerToken +
      tokenUsage.outputTokens * rates.outputPerToken;
    const score = clampScore(1 - costUsd / this.maxCostUsd);

    return {
      score,
      reason: `Estimated cost $${costUsd.toFixed(6)}`,
      metadata: { costUsd, provider, tokenUsage },
    };
  }
}

/** Asks an LLM to rate relevance of the response to the query (0–1). */
export class RelevanceScorer implements Scorer {
  readonly name = 'relevance';

  constructor(private readonly provider: CompletionProvider) {}

  async score(input: string, output: string): Promise<ScoreResult> {
    return gradeWithModel(
      this.provider,
      `Rate 0-1 how relevant this response is to the query.\n` +
        `Query: ${input}\n` +
        `Response: ${output}\n` +
        `Respond with JSON: { "score": number, "reason": string }`,
    );
  }
}

/** Asks an LLM to compare the output against an expected reference answer. */
export class CorrectnessScorer implements Scorer {
  readonly name = 'correctness';

  constructor(private readonly provider: CompletionProvider) {}

  async score(input: string, output: string, expected?: string): Promise<ScoreResult> {
    if (!expected) {
      return { score: 0, reason: 'No expected output provided' };
    }

    return gradeWithModel(
      this.provider,
      `Rate 0-1 how correct this response is compared to the expected answer.\n` +
        `Query: ${input}\n` +
        `Response: ${output}\n` +
        `Expected: ${expected}\n` +
        `Respond with JSON: { "score": number, "reason": string }`,
    );
  }
}

/** Asks an LLM to rate how helpful the response is (0–1). */
export class HelpfulnessScorer implements Scorer {
  readonly name = 'helpfulness';

  constructor(private readonly provider: CompletionProvider) {}

  async score(input: string, output: string): Promise<ScoreResult> {
    return gradeWithModel(
      this.provider,
      `Rate 0-1 how helpful this response is.\n` +
        `Query: ${input}\n` +
        `Response: ${output}\n` +
        `Respond with JSON: { "score": number, "reason": string }`,
    );
  }
}

/** Asks an LLM whether the response matches a target tone (0–1). */
export class ToneScorer implements Scorer {
  readonly name: string;

  constructor(
    private readonly provider: CompletionProvider,
    private readonly targetTone: string,
  ) {
    this.name = `tone(${targetTone})`;
  }

  async score(input: string, output: string): Promise<ScoreResult> {
    return gradeWithModel(
      this.provider,
      `Rate 0-1 how well this response matches the target tone "${this.targetTone}".\n` +
        `Query: ${input}\n` +
        `Response: ${output}\n` +
        `Respond with JSON: { "score": number, "reason": string }`,
    );
  }
}

async function gradeWithModel(
  provider: CompletionProvider,
  prompt: string,
): Promise<ScoreResult> {
  const completion = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
  });

  return parseGradeJson(extractCompletionText(completion));
}

function extractCompletionText(completion: CompletionResult): string {
  return extractTextFromContent(completion.content).trim();
}

/** Parse model-graded JSON `{ score, reason }` from grader output. */
export function parseGradeJson(text: string): ScoreResult {
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    text.match(/\{[\s\S]*\}/)?.[0],
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { score?: unknown; reason?: unknown };
      if (parsed.score !== undefined && parsed.score !== null) {
        return {
          score: clampScore(Number(parsed.score)),
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          metadata: { raw: text },
        };
      }
    } catch {
      // Try the next candidate.
    }
  }

  return { score: 0, reason: 'Grader did not return JSON', metadata: { raw: text } };
}

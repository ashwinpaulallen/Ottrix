import { TypeSafeClient, choice, noul as jevBoolean, score } from '@typesafe-ai/sdk';
import { mapTypeSafeError } from './errors.js';
import type { JevDecision, TypeSafeClientConfig } from './types.js';

/** Normalized answer shape used by higher-level decision helpers. */
export interface JevAnswer {
  choice?: string;
  score?: number;
  boolean?: boolean;
  confidence: number;
}

export class JevClient {
  private client: TypeSafeClient;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config?: TypeSafeClientConfig) {
    this.client = new TypeSafeClient({ apiKey: config?.apiKey });
    this.timeoutMs = config?.timeoutMs ?? 5000;
    this.maxRetries = config?.maxRetries ?? 1;
  }

  /**
   * Core method: send state + questions to Jev, get typed answers back.
   * Handles timeout, retry, and error normalization.
   * All higher-level decision methods call this.
   */
  async decide<TQuestions extends Record<string, unknown>>(params: {
    state: Record<string, unknown>;
    questions: TQuestions;
  }): Promise<{
    answers: { [K in keyof TQuestions]: JevAnswer };
    latencyMs: number;
  }> {
    const start = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        const response = await new Promise<{ answers: unknown }>((resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('timeout'));
            controller.abort();
          }, this.timeoutMs);

          void this.client
            .systemOne(
              {
                state: params.state,
                questions: params.questions,
              } as never,
              { signal: controller.signal, timeout: this.timeoutMs },
            )
            .then(
              (value) => resolve(value),
              (err: unknown) => reject(err),
            );
        });

        return {
          answers: response.answers as { [K in keyof TQuestions]: JevAnswer },
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        lastError = err;
        const mapped = mapTypeSafeError(err);
        if (!mapped.retryable || attempt === this.maxRetries) {
          throw mapped;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }

    throw mapTypeSafeError(lastError);
  }

  /**
   * Convenience: extract a JevDecision<T> from the raw answer object.
   * Normalizes choice/score/boolean answers into a uniform shape.
   */
  static extractDecision<T>(answer: JevAnswer, latencyMs: number): JevDecision<T> {
    const value = (answer.choice ?? answer.score ?? answer.boolean) as T;
    return {
      value,
      confidence: answer.confidence,
      latencyMs,
    };
  }

  // ── Re-export question constructors for convenience ────────────────────
  // The SDK names yes/no questions `noul`. Callers use `JevClient.boolean`.
  // SDK scores are a rubric indexed from zero. `JevClient.score(question, max)`
  // builds that rubric so callers can pass a top score (for example 5).

  static choice = choice;
  static score = scoreQuestion;
  static boolean = jevBoolean;
}

function scoreQuestion(
  instructions: string,
  criteriaOrMax: number | readonly [unknown, unknown, ...unknown[]],
) {
  if (typeof criteriaOrMax === 'number') {
    if (!Number.isInteger(criteriaOrMax) || criteriaOrMax < 1) {
      throw new TypeError(
        `JevClient.score maxScore must be an integer >= 1, received ${criteriaOrMax}`,
      );
    }
    const criteria = Array.from({ length: criteriaOrMax + 1 }, () => null) as [
      null,
      null,
      ...null[],
    ];
    return score(instructions, criteria);
  }
  return score(instructions, criteriaOrMax as never);
}

/**
 * Factory function — the public API for creating a JevClient.
 * Reads TYPESAFE_API_KEY from the environment if not provided.
 */
export function createJevClient(config?: TypeSafeClientConfig): JevClient {
  return new JevClient(config);
}

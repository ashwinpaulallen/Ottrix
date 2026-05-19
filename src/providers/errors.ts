/**
 * Machine-readable error categories for provider failures.
 */
export type ProviderErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'context_length'
  | 'content_filter'
  | 'invalid_request'
  | 'server_error'
  | 'timeout'
  | 'unknown';

/**
 * Options for constructing a {@link ProviderError}.
 */
export interface ProviderErrorOptions {
  /** Normalized failure category. */
  code: ProviderErrorCode;
  /** Whether the operation may be retried safely. */
  retryable: boolean;
  /** Original thrown value before normalization. */
  originalError?: unknown;
}

/**
 * Unified error type thrown by {@link import('./base.js').BaseProvider} and concrete providers.
 *
 * Wraps HTTP, network, and vendor-specific failures behind a consistent shape for retry logic
 * and observability.
 */
export class ProviderError extends Error {
  /** Normalized failure category. */
  readonly code: ProviderErrorCode;

  /** Whether the failed operation should be retried. */
  readonly retryable: boolean;

  /** Original thrown value before normalization. */
  readonly originalError: unknown;

  /**
   * @param message - Human-readable error description.
   * @param options - Structured error metadata.
   */
  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.originalError });
    this.name = 'ProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.originalError = options.originalError;
  }

  /**
   * Type guard for {@link ProviderError} instances.
   */
  static isProviderError(error: unknown): error is ProviderError {
    return error instanceof ProviderError;
  }
}

/** Per-provider attempt history inside an {@link AggregateProviderError}. */
export interface AggregateProviderAttempt {
  /** Registry provider name. */
  provider: string;
  /** Errors from each attempt on this provider (newest last). */
  attempts: ProviderError[];
}

/**
 * Thrown when every provider in a fallback chain has been exhausted.
 */
export class AggregateProviderError extends Error {
  readonly name = 'AggregateProviderError';

  /** Errors grouped by provider in chain order. */
  readonly errors: AggregateProviderAttempt[];

  /**
   * @param errors - Attempt history per provider.
   * @param message - Optional override; otherwise a summary is built automatically.
   */
  constructor(errors: AggregateProviderAttempt[], message?: string) {
    super(message ?? AggregateProviderError.buildMessage(errors));
    this.errors = errors;
  }

  /** Type guard for {@link AggregateProviderError}. */
  static isAggregateProviderError(error: unknown): error is AggregateProviderError {
    return error instanceof AggregateProviderError;
  }

  /** Returns the last error from the final provider attempted, if any. */
  getLastError(): ProviderError | undefined {
    const lastProvider = this.errors[this.errors.length - 1];
    if (!lastProvider || lastProvider.attempts.length === 0) return undefined;
    return lastProvider.attempts[lastProvider.attempts.length - 1];
  }

  /** Build a human-readable summary of what was tried. */
  static buildMessage(errors: AggregateProviderAttempt[]): string {
    if (errors.length === 0) {
      return 'All providers in the fallback chain failed.';
    }

    const parts = errors.map((entry) => {
      const last = entry.attempts[entry.attempts.length - 1];
      const detail = last ? `${last.code}: ${last.message}` : 'no attempts recorded';
      return `${entry.provider} (${entry.attempts.length} attempt(s), ${detail})`;
    });

    return `All providers failed. Tried: ${parts.join('; ')}.`;
  }
}

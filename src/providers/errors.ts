/**
 * Machine-readable error categories for provider failures.
 */
export type ProviderErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'context_length'
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

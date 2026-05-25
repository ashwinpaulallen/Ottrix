import { StructuredOutputError } from '../agent/structured-output.js';
import type { RemainingBudget } from '../guardrails/budget.js';
import { Logger } from '../observability/logger.js';
import { CircuitOpenError } from '../providers/circuit-breaker.js';
import {
  AggregateProviderError,
  ProviderError,
  type ProviderErrorCode,
} from '../providers/errors.js';

const httpLogger = new Logger({ component: 'http' });

/** HTTP error payload returned to API clients. */
export interface HttpErrorResponse {
  status: number;
  body: { error: string; code: string; details?: unknown };
  headers?: Record<string, string>;
}

/** Thrown when a budget scope is exhausted. */
export class BudgetExhaustedError extends Error {
  readonly name = 'BudgetExhaustedError';

  constructor(
    message: string,
    readonly remaining?: RemainingBudget,
  ) {
    super(message);
  }

  /** Type guard for {@link BudgetExhaustedError}. */
  static isBudgetExhaustedError(error: unknown): error is BudgetExhaustedError {
    return error instanceof BudgetExhaustedError;
  }
}

/** Thrown when prompt injection is detected and the request is blocked. */
export class InjectionDetectedError extends Error {
  readonly name = 'InjectionDetectedError';

  constructor(
    message: string,
    readonly category?: string,
  ) {
    super(message);
  }

  /** Type guard for {@link InjectionDetectedError}. */
  static isInjectionDetectedError(error: unknown): error is InjectionDetectedError {
    return error instanceof InjectionDetectedError;
  }
}

const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60;

/** Map any ottrix error to a sanitized HTTP response. */
export function mapOttrixError(error: unknown): HttpErrorResponse {
  httpLogger.error('HTTP request failed', {
    error: serializeErrorForLog(error),
  });

  if (isProviderError(error)) {
    return mapProviderError(error);
  }

  if (isCircuitOpenError(error)) {
    return {
      status: 503,
      body: { error: 'Service temporarily unavailable', code: 'circuit_open' },
      headers: {
        'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
      },
    };
  }

  if (isStructuredOutputError(error)) {
    return {
      status: 422,
      body: {
        error: 'Response validation failed',
        code: 'structured_output_error',
        details: {
          attempts: error.attempts,
          issues: error.zodErrors.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    };
  }

  if (isBudgetExhaustedError(error)) {
    return {
      status: 429,
      body: {
        error: 'Budget exhausted',
        code: 'budget_exhausted',
        details: error.remaining,
      },
    };
  }

  if (isAggregateProviderError(error)) {
    return {
      status: 503,
      body: { error: 'All providers failed', code: 'all_providers_failed' },
    };
  }

  if (isInjectionDetectedError(error)) {
    return {
      status: 403,
      body: { error: 'Request blocked', code: 'injection_detected' },
    };
  }

  return {
    status: 500,
    body: { error: 'Internal server error', code: 'internal_error' },
  };
}

function isProviderError(error: unknown): error is ProviderError {
  return (
    ProviderError.isProviderError(error) ||
    (error instanceof Error &&
      error.name === 'ProviderError' &&
      typeof (error as ProviderError).code === 'string')
  );
}

function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return (
    CircuitOpenError.isCircuitOpenError(error) ||
    (error instanceof Error &&
      error.name === 'CircuitOpenError' &&
      typeof (error as CircuitOpenError).retryAfterMs === 'number')
  );
}

function isStructuredOutputError(error: unknown): error is StructuredOutputError {
  return (
    error instanceof StructuredOutputError ||
    (error instanceof Error &&
      error.name === 'StructuredOutputError' &&
      'zodErrors' in error &&
      'attempts' in error)
  );
}

function isBudgetExhaustedError(error: unknown): error is BudgetExhaustedError {
  return (
    BudgetExhaustedError.isBudgetExhaustedError(error) ||
    (error instanceof Error && error.name === 'BudgetExhaustedError')
  );
}

function isAggregateProviderError(error: unknown): error is AggregateProviderError {
  return (
    error instanceof AggregateProviderError ||
    (error instanceof Error && error.name === 'AggregateProviderError' && 'errors' in error)
  );
}

function isInjectionDetectedError(error: unknown): error is InjectionDetectedError {
  return (
    InjectionDetectedError.isInjectionDetectedError(error) ||
    (error instanceof Error && error.name === 'InjectionDetectedError')
  );
}

function mapProviderError(error: ProviderError): HttpErrorResponse {
  switch (error.code) {
    case 'rate_limit':
      return {
        status: 429,
        body: { error: 'Rate limit exceeded', code: error.code },
        headers: { 'Retry-After': String(DEFAULT_RATE_LIMIT_RETRY_SECONDS) },
      };
    case 'auth':
      return {
        status: 502,
        body: { error: 'Provider authentication failed', code: error.code },
      };
    case 'context_length':
      return {
        status: 400,
        body: { error: 'Input too long for model context', code: error.code },
      };
    case 'server_error':
      return {
        status: 502,
        body: { error: 'LLM provider error', code: error.code },
      };
    case 'timeout':
      return {
        status: 504,
        body: { error: 'Provider timeout', code: error.code },
      };
    default:
      return mapProviderErrorByFallbackCode(error.code, error);
  }
}

function mapProviderErrorByFallbackCode(
  code: ProviderErrorCode,
  error: ProviderError,
): HttpErrorResponse {
  if (code === 'content_filter' || code === 'invalid_request') {
    return {
      status: 400,
      body: { error: 'Invalid request', code },
    };
  }

  return {
    status: 502,
    body: { error: 'LLM provider error', code: error.code },
  };
}

function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error instanceof ProviderError
        ? { code: error.code, retryable: error.retryable }
        : {}),
      ...(error instanceof CircuitOpenError
        ? { provider: error.provider, retryAfterMs: error.retryAfterMs }
        : {}),
    };
  }

  return { value: error };
}

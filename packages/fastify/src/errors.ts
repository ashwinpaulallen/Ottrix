import {
  CircuitOpenError,
  ProviderError,
  StructuredOutputError,
} from 'ottrix';

/** Thrown when a budget guardrail blocks a request before processing. */
export class BudgetExhaustedError extends Error {
  readonly name = 'BudgetExhaustedError';

  constructor(message = 'Budget exceeded') {
    super(message);
  }
}

/** HTTP mapping for an Ottrix error. */
export interface OttrixErrorMapping {
  status: number;
  message: string;
  retryAfter?: string;
}

/** Map Ottrix error types to HTTP status codes. */
export function mapOttrixError(error: unknown): OttrixErrorMapping {
  switch ((error as Error)?.constructor?.name) {
    case ProviderError.name:
      return {
        status: 502,
        message: error instanceof Error ? error.message : 'Provider error',
      };
    case StructuredOutputError.name:
      return {
        status: 422,
        message: error instanceof Error ? error.message : 'Structured output error',
      };
    case CircuitOpenError.name:
      return {
        status: 503,
        message: error instanceof Error ? error.message : 'Circuit open',
        retryAfter: CircuitOpenError.isCircuitOpenError(error)
          ? String(Math.ceil(error.retryAfterMs / 1000))
          : undefined,
      };
    case BudgetExhaustedError.name:
      return {
        status: 429,
        message: error instanceof Error ? error.message : 'Budget exceeded',
      };
    default:
      return {
        status: 500,
        message: error instanceof Error ? error.message : 'Internal server error',
      };
  }
}

/** Register Ottrix-aware error handling on a Fastify instance. */
export function registerOttrixErrorHandler(fastify: {
  setErrorHandler: (
    handler: (error: Error, request: unknown, reply: OttrixReplyLike) => void | Promise<void>,
  ) => void;
}): void {
  fastify.setErrorHandler((error, _request, reply) => {
    if (reply.sent) {
      throw error;
    }

    const mapped = mapOttrixError(error);
    if (mapped.retryAfter) {
      reply.header('Retry-After', mapped.retryAfter);
    }
    reply.code(mapped.status).send({ error: mapped.message });
  });
}

interface OttrixReplyLike {
  sent: boolean;
  header: (name: string, value: string) => OttrixReplyLike;
  code: (status: number) => OttrixReplyLike;
  send: (payload: unknown) => unknown;
}

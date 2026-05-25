import type { ErrorRequestHandler } from 'express';
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

/** Maps Ottrix error types to HTTP status codes. */
export function ottrixErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    switch (err?.constructor?.name) {
      case ProviderError.name:
        res.status(502).json({ error: err instanceof Error ? err.message : 'Provider error' });
        return;
      case StructuredOutputError.name:
        res.status(422).json({ error: err instanceof Error ? err.message : 'Structured output error' });
        return;
      case CircuitOpenError.name:
        if (CircuitOpenError.isCircuitOpenError(err)) {
          res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
        }
        res.status(503).json({ error: err instanceof Error ? err.message : 'Circuit open' });
        return;
      case BudgetExhaustedError.name:
        res.status(429).json({ error: err instanceof Error ? err.message : 'Budget exceeded' });
        return;
      default:
        res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
    }
  };
}

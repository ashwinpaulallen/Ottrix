import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StructuredOutputError } from '../../src/agent/structured-output.js';
import { CircuitOpenError } from '../../src/providers/circuit-breaker.js';
import {
  AggregateProviderError,
  ProviderError,
} from '../../src/providers/errors.js';
import {
  BudgetExhaustedError,
  InjectionDetectedError,
  mapOttrixError,
} from '../../src/http/errors.js';

const SECRET = 'INTERNAL_SECRET_DO_NOT_LEAK_abc123';

describe('mapOttrixError', () => {
  it('maps ProviderError rate_limit to 429 with Retry-After', () => {
    const mapped = mapOttrixError(
      new ProviderError(SECRET, { code: 'rate_limit', retryable: true }),
    );

    expect(mapped.status).toBe(429);
    expect(mapped.body.code).toBe('rate_limit');
    expect(mapped.headers?.['Retry-After']).toBeDefined();
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps ProviderError auth to 502', () => {
    const mapped = mapOttrixError(
      new ProviderError(SECRET, { code: 'auth', retryable: false }),
    );

    expect(mapped.status).toBe(502);
    expect(mapped.body.error).toBe('Provider authentication failed');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps ProviderError context_length to 400', () => {
    const mapped = mapOttrixError(
      new ProviderError(SECRET, { code: 'context_length', retryable: false }),
    );

    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toBe('Input too long for model context');
  });

  it('maps ProviderError server_error to 502', () => {
    const mapped = mapOttrixError(
      new ProviderError(SECRET, { code: 'server_error', retryable: true }),
    );

    expect(mapped.status).toBe(502);
    expect(mapped.body.error).toBe('LLM provider error');
  });

  it('maps ProviderError timeout to 504', () => {
    const mapped = mapOttrixError(
      new ProviderError(SECRET, { code: 'timeout', retryable: true }),
    );

    expect(mapped.status).toBe(504);
    expect(mapped.body.error).toBe('Provider timeout');
  });

  it('maps CircuitOpenError to 503 with Retry-After', () => {
    const mapped = mapOttrixError(
      new CircuitOpenError(SECRET, 'anthropic', 30_000),
    );

    expect(mapped.status).toBe(503);
    expect(mapped.headers?.['Retry-After']).toBe('30');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps StructuredOutputError to 422 with validation details', () => {
    const schema = z.object({ answer: z.string() });
    const parsed = schema.safeParse({ answer: 123 });
    const zodError = parsed.success ? new z.ZodError([]) : parsed.error;

    const mapped = mapOttrixError(
      new StructuredOutputError(SECRET, '{"answer":123}', zodError, 2),
    );

    expect(mapped.status).toBe(422);
    expect(mapped.body.code).toBe('structured_output_error');
    expect(mapped.body.details).toBeDefined();
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps BudgetExhaustedError to 429 with remaining budget details', () => {
    const remaining = {
      steps: { used: 10, limit: 10, remaining: 0 },
      tokens: { used: 100, limit: 100, remaining: 0 },
      costUsd: { used: 1, limit: 1, remaining: 0 },
    };

    const mapped = mapOttrixError(new BudgetExhaustedError(SECRET, remaining));

    expect(mapped.status).toBe(429);
    expect(mapped.body.code).toBe('budget_exhausted');
    expect(mapped.body.details).toEqual(remaining);
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps AggregateProviderError to 503', () => {
    const mapped = mapOttrixError(
      new AggregateProviderError([
        {
          provider: 'primary',
          attempts: [
            new ProviderError(SECRET, { code: 'server_error', retryable: true }),
          ],
        },
      ]),
    );

    expect(mapped.status).toBe(503);
    expect(mapped.body.error).toBe('All providers failed');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps InjectionDetectedError to 403', () => {
    const mapped = mapOttrixError(new InjectionDetectedError(SECRET, 'jailbreak'));

    expect(mapped.status).toBe(403);
    expect(mapped.body.error).toBe('Request blocked');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('maps unknown errors to 500 without leaking messages', () => {
    const mapped = mapOttrixError(new Error(SECRET));

    expect(mapped.status).toBe(500);
    expect(mapped.body.error).toBe('Internal server error');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });
});

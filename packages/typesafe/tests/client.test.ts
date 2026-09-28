import { beforeEach, describe, expect, it, vi } from 'vitest';

const systemOne = vi.hoisted(() => vi.fn());

vi.mock('@typesafe-ai/sdk', () => {
  class MockTypeSafeClient {
    systemOne = systemOne;
    constructor(_config?: { apiKey?: string }) {}
  }

  return {
    TypeSafeClient: MockTypeSafeClient,
    choice: vi.fn((instructions: unknown, criteria: unknown) => ({
      type: 'choice',
      instructions,
      criteria,
    })),
    score: vi.fn((instructions: unknown, criteria: unknown) => ({
      type: 'score',
      instructions,
      criteria,
    })),
    noul: vi.fn((instructions?: unknown, criteria?: unknown) => ({
      type: 'noul',
      instructions,
      criteria,
    })),
  };
});

import { JevClient } from '../src/client.js';
import { TypeSafeError } from '../src/errors.js';

const params = {
  state: { document: 'I was charged twice.' },
  questions: {
    category: { type: 'choice', instructions: 'What category?', criteria: { billing: null } },
  },
};

function answered(answers: Record<string, unknown>) {
  return {
    model: 'jev-latest',
    answers,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('JevClient', () => {
  beforeEach(() => {
    systemOne.mockReset();
  });

  it('decide() calls client.systemOne with correct params', async () => {
    systemOne.mockResolvedValue(answered({ category: { choice: 'billing', confidence: 0.9 } }));
    const client = new JevClient({ apiKey: 'test-key', maxRetries: 0 });

    await client.decide(params);

    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(systemOne).toHaveBeenCalledWith(
      { state: params.state, questions: params.questions },
      expect.objectContaining({
        timeout: 5000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('decide() returns latencyMs', async () => {
    systemOne.mockResolvedValue(answered({ category: { choice: 'billing', confidence: 0.9 } }));
    const client = new JevClient({ apiKey: 'test-key', maxRetries: 0 });
    const started = Date.now();

    const result = await client.decide(params);

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThanOrEqual(Date.now() - started + 20);
    expect(result.answers.category).toEqual({ choice: 'billing', confidence: 0.9 });
  });

  it('decide() retries on rate_limit errors', async () => {
    systemOne
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce(answered({ category: { choice: 'billing', confidence: 0.8 } }));
    const client = new JevClient({ apiKey: 'test-key', maxRetries: 1 });

    const result = await client.decide(params);

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(result.answers.category.choice).toBe('billing');
  });

  it('decide() retries on timeout errors', async () => {
    systemOne
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(answered({ category: { choice: 'technical', confidence: 0.7 } }));
    const client = new JevClient({ apiKey: 'test-key', maxRetries: 1 });

    const result = await client.decide(params);

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(result.answers.category.choice).toBe('technical');
  });

  it('decide() does not retry on auth errors', async () => {
    systemOne.mockRejectedValue(new Error('401 Unauthorized'));
    const client = new JevClient({ apiKey: 'test-key', maxRetries: 2 });

    await expect(client.decide(params)).rejects.toMatchObject({
      name: 'TypeSafeError',
      code: 'auth',
      retryable: false,
    });
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it('decide() throws TypeSafeError on failure', async () => {
    systemOne.mockRejectedValue(new Error('something broke'));
    const client = new JevClient({ apiKey: 'test-key', maxRetries: 0 });

    await expect(client.decide(params)).rejects.toBeInstanceOf(TypeSafeError);
    await expect(client.decide(params)).rejects.toMatchObject({
      code: 'unknown',
      retryable: false,
    });
  });

  it('decide() aborts after timeoutMs', async () => {
    systemOne.mockImplementation(
      (_request: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('Request was aborted.'));
          });
        }),
    );
    const client = new JevClient({ apiKey: 'test-key', timeoutMs: 30, maxRetries: 0 });
    const started = Date.now();

    await expect(client.decide(params)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1000);
    const signal = systemOne.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('extractDecision() handles choice answer', () => {
    expect(JevClient.extractDecision<string>({ choice: 'billing', confidence: 0.91 }, 12)).toEqual({
      value: 'billing',
      confidence: 0.91,
      latencyMs: 12,
    });
  });

  it('extractDecision() handles score answer', () => {
    expect(JevClient.extractDecision<number>({ score: 4, confidence: 0.7 }, 8)).toEqual({
      value: 4,
      confidence: 0.7,
      latencyMs: 8,
    });
  });

  it('extractDecision() handles boolean answer', () => {
    expect(JevClient.extractDecision<boolean>({ boolean: false, confidence: 0.66 }, 5)).toEqual({
      value: false,
      confidence: 0.66,
      latencyMs: 5,
    });
  });
});

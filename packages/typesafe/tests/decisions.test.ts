import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import { JevDecisionMaker } from '../src/decisions.js';

function maker() {
  return new JevDecisionMaker({ apiKey: 'test-key' });
}

describe('JevDecisionMaker', () => {
  let decide: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    decide = vi.spyOn(JevClient.prototype, 'decide');
  });

  afterEach(() => {
    decide.mockRestore();
  });

  it('scores fraud and recommends an action', async () => {
    decide.mockResolvedValue({
      answers: {
        fraudScore: { score: 8, confidence: 0.92 },
        recommendation: { choice: 'reject', confidence: 0.9 },
      },
      latencyMs: 14,
    });
    const order = { orderValue: 900, isFirstOrder: true, cardVelocity: 4 };

    const result = await maker().scoreFraud(order);

    expect(result.score).toEqual({ value: 8, confidence: 0.92, latencyMs: 14 });
    expect(result.recommendation).toEqual({ value: 'reject', confidence: 0.9, latencyMs: 14 });
    expect(result.shouldRunFullAgent).toBe(false);
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: order,
      }),
    );
  });

  it('runs the full fraud agent for grey-zone scores', async () => {
    decide.mockResolvedValue({
      answers: {
        fraudScore: { score: 5, confidence: 0.95 },
        recommendation: { choice: 'review', confidence: 0.8 },
      },
      latencyMs: 10,
    });

    const result = await maker().scoreFraud({ orderValue: 40 });

    expect(result.shouldRunFullAgent).toBe(true);
  });

  it('runs the full fraud agent when score confidence is below autoAct', async () => {
    decide.mockResolvedValue({
      answers: {
        fraudScore: { score: 1, confidence: 0.4 },
        recommendation: { choice: 'approve', confidence: 0.4 },
      },
      latencyMs: 10,
    });

    const result = await maker().scoreFraud({ orderValue: 20 });

    expect(result.shouldRunFullAgent).toBe(true);
  });

  it('defaults a missing fraud score to 5 and a missing recommendation to review', async () => {
    decide.mockResolvedValue({
      answers: {
        fraudScore: { confidence: 0.9 },
        recommendation: { confidence: 0.5 },
      },
      latencyMs: 9,
    });

    const result = await maker().scoreFraud({ orderValue: 15 });

    expect(result.score.value).toBe(5);
    expect(result.recommendation.value).toBe('review');
    expect(result.shouldRunFullAgent).toBe(true);
  });

  it('checks whether a tool is related and can execute now', async () => {
    decide.mockResolvedValue({
      answers: {
        isRelated: { boolean: true, confidence: 0.88 },
        canExecuteNow: { boolean: false, confidence: 0.7 },
        suggestedAlternative: { choice: 'search_orders', confidence: 0.66 },
      },
      latencyMs: 11,
    });

    const result = await maker().checkToolAcceptance({
      toolName: 'refund_order',
      toolDescription: 'Refunds an order',
      userRequest: 'I want my money back',
      isAuthenticated: false,
      rateLimitRemaining: 2,
      availableAlternatives: ['search_orders', 'email_support'],
    });

    expect(result.isRelated).toEqual({ value: true, confidence: 0.88, latencyMs: 11 });
    expect(result.canExecuteNow).toEqual({ value: false, confidence: 0.7, latencyMs: 11 });
    expect(result.suggestedAlternative).toEqual({
      value: 'search_orders',
      confidence: 0.66,
      latencyMs: 11,
    });
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          toolName: 'refund_order',
          toolDescription: 'Refunds an order',
          userRequest: 'I want my money back',
          isAuthenticated: false,
          rateLimitRemaining: 2,
          alternatives: 'search_orders, email_support',
        },
      }),
    );
    const questions = decide.mock.calls[0]?.[0]?.questions as {
      suggestedAlternative: { criteria: Record<string, null> };
    };
    expect(questions.suggestedAlternative.criteria).toEqual({
      none: null,
      search_orders: null,
      email_support: null,
    });
  });

  it('maps a none alternative to null and applies tool-acceptance defaults', async () => {
    decide.mockResolvedValue({
      answers: {
        isRelated: { confidence: 0.5 },
        canExecuteNow: { confidence: 0.5 },
        suggestedAlternative: { choice: 'none', confidence: 0.4 },
      },
      latencyMs: 8,
    });

    const result = await maker().checkToolAcceptance({
      toolName: 'lookup',
      toolDescription: 'Looks up a record',
      userRequest: 'Find order 12',
    });

    expect(result.isRelated.value).toBe(false);
    expect(result.canExecuteNow.value).toBe(true);
    expect(result.suggestedAlternative.value).toBeNull();
    const state = decide.mock.calls[0]?.[0]?.state as Record<string, unknown>;
    expect(state.isAuthenticated).toBe(true);
    expect(state.rateLimitRemaining).toBe(100);
    expect(state.alternatives).toBe('none');
  });

  it('decide() returns a boolean decision', async () => {
    decide.mockResolvedValue({
      answers: { answer: { boolean: true, confidence: 0.81 } },
      latencyMs: 7,
    });

    const result = await maker().decide({
      state: { text: 'A short family article' },
      question: 'Is this article suitable for a family audience?',
    });

    expect(result).toEqual({ value: true, confidence: 0.81, latencyMs: 7 });
  });

  it('classify() returns the chosen label and falls back to the first option', async () => {
    decide.mockResolvedValueOnce({
      answers: { choice: { choice: 'billing', confidence: 0.77 } },
      latencyMs: 6,
    });
    const jev = maker();

    const chosen = await jev.classify({
      state: { email: 'I was charged twice' },
      question: 'What category is this customer email?',
      options: ['billing', 'technical', 'sales'],
    });

    expect(chosen).toEqual({ value: 'billing', confidence: 0.77, latencyMs: 6 });

    decide.mockResolvedValueOnce({
      answers: { choice: { confidence: 0.2 } },
      latencyMs: 6,
    });
    const fallback = await jev.classify({
      state: { email: '' },
      question: 'What category is this customer email?',
      options: ['billing', 'technical'],
    });
    expect(fallback.value).toBe('billing');
  });

  it('scoreOn() returns a numeric score', async () => {
    decide.mockResolvedValue({
      answers: { score: { score: 7, confidence: 0.73 } },
      latencyMs: 5,
    });

    const result = await maker().scoreOn({
      state: { response: 'Done.', goal: 'Ship it' },
      question: 'How well does this response address the user goal?',
      maxScore: 10,
    });

    expect(result).toEqual({ value: 7, confidence: 0.73, latencyMs: 5 });
  });
});

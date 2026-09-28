import type { EvaluationContext } from 'ottrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import { JevEvaluatorStrategy } from '../src/evaluator.js';

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    originalGoal: 'Summarize the invoice',
    currentResponse: 'Here is a summary.',
    conversationHistory: [],
    refinementNumber: 1,
    stepsSoFar: 3,
    toolsAvailable: ['lookup_invoice', 'send_email'],
    toolsUsed: ['lookup_invoice'],
    ...overrides,
  };
}

function decision(overrides?: {
  sufficient?: boolean;
  confidence?: number;
  missingInfo?: boolean;
  suggestedAction?: string;
  qualityScore?: number;
}) {
  return {
    answers: {
      sufficient: {
        boolean: overrides?.sufficient ?? true,
        confidence: overrides?.confidence ?? 0.92,
      },
      missingInfo: {
        boolean: overrides?.missingInfo ?? false,
        confidence: 0.8,
      },
      suggestedAction: {
        choice: overrides?.suggestedAction ?? 'finalize',
        confidence: 0.9,
      },
      qualityScore: {
        score: overrides?.qualityScore ?? 4,
        confidence: 0.88,
      },
    },
    latencyMs: 15,
  };
}

describe('JevEvaluatorStrategy', () => {
  let decide: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    decide = vi.spyOn(JevClient.prototype, 'decide');
  });

  afterEach(() => {
    decide.mockRestore();
  });

  function strategy() {
    return new JevEvaluatorStrategy({ apiKey: 'test-key' });
  }

  it('maps a Jev boolean true to sufficient: true', async () => {
    decide.mockResolvedValue(decision({ sufficient: true, suggestedAction: 'refine_response' }));

    const result = await strategy().evaluate(context());

    expect(result.sufficient).toBe(true);
    expect(result.suggestedAction).toBe('finalize');
  });

  it('maps a Jev boolean false to sufficient: false with suggestedAction', async () => {
    decide.mockResolvedValue(
      decision({ sufficient: false, suggestedAction: 'use_tool', missingInfo: false }),
    );

    const result = await strategy().evaluate(context());

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('use_tool');
    expect(result.reason).toBe('Response incomplete — suggested action: use_tool');
    expect(result.missingAspects).toBeUndefined();
  });

  it('maps confidence from the sufficient answer', async () => {
    decide.mockResolvedValue(decision({ confidence: 0.77 }));

    const result = await strategy().evaluate(context());

    expect(result.confidence).toBe(0.77);
  });

  it('assumes sufficient when confidence is below the escalation threshold', async () => {
    decide.mockResolvedValue(decision({ sufficient: false, confidence: 0.49, qualityScore: 1 }));

    const result = await strategy().evaluate(context());

    expect(result).toEqual({
      sufficient: true,
      confidence: 0.5,
      reason: 'Jev confidence below escalation threshold — assuming sufficient',
      suggestedAction: 'finalize',
    });
  });

  it('assumes sufficient when Jev throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decide.mockRejectedValue(new Error('Jev unavailable'));

    const result = await strategy().evaluate(context());

    expect(result).toEqual({
      sufficient: true,
      confidence: 0.5,
      reason: 'Jev evaluation failed — assuming sufficient (fail-safe)',
      suggestedAction: 'finalize',
    });
    expect(warn).toHaveBeenCalledWith(
      '[ottrix:jev-evaluator] Jev evaluation failed, assuming sufficient:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('includes the quality score in the reason when the response is sufficient', async () => {
    decide.mockResolvedValue(decision({ sufficient: true, qualityScore: 4 }));

    const result = await strategy().evaluate(context());

    expect(result.reason).toBe('Response addresses the request (quality: 4/5)');
  });

  it('populates missingAspects when the response is insufficient and missingInfo is true', async () => {
    decide.mockResolvedValue(
      decision({ sufficient: false, missingInfo: true, suggestedAction: 'use_tool' }),
    );

    const result = await strategy().evaluate(context());

    expect(result.sufficient).toBe(false);
    expect(result.missingAspects).toEqual(['Agent has tools available that may help fill the gap']);
  });

  it('sends originalGoal, currentResponse, and toolsAvailable in state', async () => {
    decide.mockResolvedValue(decision());
    const ctx = context();

    await strategy().evaluate(ctx);

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          originalGoal: ctx.originalGoal,
          currentResponse: ctx.currentResponse,
          toolsAvailable: 'lookup_invoice, send_email',
          toolsUsed: 'lookup_invoice',
          stepCount: 3,
          refinementNumber: 1,
          responseLength: ctx.currentResponse.length,
        }),
      }),
    );
    const state = decide.mock.calls[0]?.[0]?.state as Record<string, unknown>;
    expect(state.criteria).toBeUndefined();
  });

  it('includes criteria in state when present on the context', async () => {
    decide.mockResolvedValue(decision());

    await strategy().evaluate(
      context({
        criteria: ['Answers all parts of the question', 'Includes specific examples'],
      }),
    );

    const state = decide.mock.calls[0]?.[0]?.state as Record<string, unknown>;
    expect(state.criteria).toBe('Answers all parts of the question; Includes specific examples');
  });
});

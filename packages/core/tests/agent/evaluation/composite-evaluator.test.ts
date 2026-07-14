import { describe, expect, it, vi } from 'vitest';
import {
  CompositeEvaluator,
  createEvaluator,
} from '../../../src/agent/evaluation/composite-evaluator.js';
import { EvaluationConfigSchema, type EvaluationContext } from '../../../src/agent/evaluation/types.js';
import { MockCompletionProvider, textCompletion } from '../../fixtures/mock-provider.js';

function baseConfig() {
  return EvaluationConfigSchema.parse({ enabled: true });
}

function baseContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    originalGoal: 'What is the capital of France?',
    currentResponse: 'The capital of France is Paris.',
    conversationHistory: [],
    refinementNumber: 0,
    stepsSoFar: 1,
    toolsAvailable: [],
    toolsUsed: [],
    ...overrides,
  };
}

function llmResultJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    sufficient: true,
    confidence: 0.9,
    reason: 'Fully answers the question',
    suggestedAction: 'finalize',
    ...overrides,
  });
}

describe('CompositeEvaluator', () => {
  it('heuristic catches problem → returns immediately without LLM call', async () => {
    const provider = new MockCompletionProvider();
    const evaluator = new CompositeEvaluator(provider, baseConfig());

    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: "I'll look that up for you.",
        toolsAvailable: ['search'],
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('use_tool');
    expect(provider.completeCalls).toBe(0);
  });

  it('heuristic passes → LLM is called', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion(llmResultJson()));
    const evaluator = new CompositeEvaluator(provider, baseConfig());

    const result = await evaluator.evaluate(baseContext());

    expect(provider.completeCalls).toBe(1);
    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe(0.9);
  });

  it('LLM says insufficient, heuristic said ok → insufficient', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(
        llmResultJson({
          sufficient: false,
          confidence: 0.85,
          reason: 'Missing concrete examples',
          missingAspects: ['examples'],
          suggestedAction: 'refine_response',
        }),
      ),
    );
    const evaluator = new CompositeEvaluator(provider, baseConfig());

    const result = await evaluator.evaluate(baseContext());

    expect(provider.completeCalls).toBe(1);
    expect(result.sufficient).toBe(false);
    expect(result.reason).toBe('Missing concrete examples');
    expect(result.missingAspects).toContain('examples');
  });

  it('both say insufficient → missingAspects merged and deduplicated', async () => {
    // Force heuristic insufficient with confidence < 0.75 so LLM still runs.
    // HeuristicEvaluator returns 0.85 on failure, which short-circuits.
    // So we spy/mock the heuristic path by constructing a composite and replacing
    // the private heuristic evaluator.
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(
        llmResultJson({
          sufficient: false,
          confidence: 0.8,
          reason: 'LLM: missing citations',
          missingAspects: ['citations', 'examples'],
          suggestedAction: 'refine_response',
        }),
      ),
    );
    const evaluator = new CompositeEvaluator(provider, baseConfig());

    const lowConfidenceHeuristic = {
      evaluate: vi.fn().mockResolvedValue({
        sufficient: false,
        confidence: 0.5, // below 0.75 → LLM still runs
        reason: 'Heuristic: suspiciously short',
        missingAspects: ['examples', 'too short'],
        suggestedAction: 'refine_response' as const,
      }),
    };
    (evaluator as unknown as { heuristic: typeof lowConfidenceHeuristic }).heuristic =
      lowConfidenceHeuristic;

    const result = await evaluator.evaluate(baseContext());

    expect(provider.completeCalls).toBe(1);
    expect(result.sufficient).toBe(false);
    expect(result.missingAspects).toEqual(['citations', 'examples', 'too short']);
  });

  it('both say sufficient → sufficient', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion(llmResultJson()));
    const evaluator = new CompositeEvaluator(provider, baseConfig());

    const result = await evaluator.evaluate(
      baseContext({
        currentResponse:
          'The capital of France is Paris. It has been the political center for centuries.',
      }),
    );

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.suggestedAction).toBe('finalize');
  });

  it('createEvaluator returns a CompositeEvaluator', () => {
    const provider = new MockCompletionProvider();
    const evaluator = createEvaluator(provider, baseConfig());

    expect(evaluator).toBeInstanceOf(CompositeEvaluator);
  });
});

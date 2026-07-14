import { describe, expect, it } from 'vitest';
import { HeuristicEvaluator } from '../../../src/agent/evaluation/heuristic-evaluator.js';
import type { EvaluationContext } from '../../../src/agent/evaluation/types.js';

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

const longGoal =
  'Please write a detailed comparison of TypeScript and JavaScript covering types, tooling, ecosystem, and migration strategies for a large codebase. '.repeat(
    1,
  ); // > 100 chars

describe('HeuristicEvaluator', () => {
  const evaluator = new HeuristicEvaluator();

  it('"I\'ll look that up" with tools available → insufficient, suggestedAction: use_tool', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: "I'll look that up for you.",
        toolsAvailable: ['search'],
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('use_tool');
    expect(result.reason).toContain('intent to act');
  });

  it('"I\'ll look that up" with NO tools → passes this check (agent can\'t act)', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: "I'll look that up for you. Paris is the capital.",
        toolsAvailable: [],
      }),
    );

    // Hedging check should not fire without tools; clean enough to pass overall
    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe(0.65);
  });

  it('"I don\'t have enough information" with unused tools → insufficient, use_tool', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: "I don't have enough information to answer that.",
        toolsAvailable: ['search', 'calculator'],
        toolsUsed: [],
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('use_tool');
    expect(result.reason).toContain("tools haven't been tried");
  });

  it('"I don\'t have enough information" with no tools → insufficient, clarify', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: "I don't have enough information to answer that.",
        toolsAvailable: [],
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('clarify');
    expect(result.reason).toContain('incompleteness');
  });

  it('goal has question mark, response is only a question → insufficient', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        originalGoal: 'What is the capital of France?',
        currentResponse: 'Which country did you mean?',
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('rethink');
    expect(result.reason).toContain('only contains questions');
  });

  it('goal is 200 chars, response is 30 chars → insufficient', async () => {
    expect(longGoal.length).toBeGreaterThan(100);

    const result = await evaluator.evaluate(
      baseContext({
        originalGoal: longGoal,
        currentResponse: 'Looks fine overall.', // < 50 chars, not confirmation
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('refine_response');
    expect(result.reason).toContain('suspiciously short');
  });

  it('goal is 200 chars, response is 30 chars but starts with "Done" → passes', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        originalGoal: longGoal,
        currentResponse: 'Done with the migration plan.',
      }),
    );

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe(0.65);
  });

  it('response contains "error occurred" with tools → suggestedAction: use_tool', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: 'An error occurred while fetching the data.',
        toolsAvailable: ['retry_fetch'],
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.suggestedAction).toBe('use_tool');
    expect(result.reason).toContain('error indicators');
  });

  it('clean, substantive response → sufficient, confidence: 0.65', async () => {
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse:
          'The capital of France is Paris. It has been the political center since the Middle Ages.',
      }),
    );

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe(0.65);
    expect(result.reason).toBe('Passed all heuristic checks');
    expect(result.suggestedAction).toBe('finalize');
  });

  it('multiple heuristic failures → all reasons in missingAspects', async () => {
    // Triggers: hedging without action + error signs (both with tools available)
    const result = await evaluator.evaluate(
      baseContext({
        currentResponse: "I'll look that up. An error occurred during the last attempt.",
        toolsAvailable: ['search'],
        toolsUsed: [],
      }),
    );

    expect(result.sufficient).toBe(false);
    expect(result.missingAspects).toBeDefined();
    expect(result.missingAspects!.length).toBeGreaterThanOrEqual(2);
    expect(result.missingAspects!.some((r) => r.includes('intent to act'))).toBe(true);
    expect(result.missingAspects!.some((r) => r.includes('error indicators'))).toBe(true);
  });
});

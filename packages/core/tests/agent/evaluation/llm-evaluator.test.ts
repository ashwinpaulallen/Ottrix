import { describe, expect, it, vi } from 'vitest';
import { LLMEvaluator } from '../../../src/agent/evaluation/llm-evaluator.js';
import {
  EvaluationConfigSchema,
  type EvaluationConfig,
  type EvaluationContext,
  type SufficiencyResult,
} from '../../../src/agent/evaluation/types.js';
import { MockCompletionProvider, textCompletion } from '../../fixtures/mock-provider.js';

type EvaluatorInternals = {
  buildEvaluationMessages: (
    ctx: EvaluationContext,
  ) => Array<{ role: 'user' | 'assistant'; content: string }>;
  buildSystemPrompt: (ctx: EvaluationContext) => string;
  parseResult: (result: { content: unknown }) => SufficiencyResult;
};

function asInternals(evaluator: LLMEvaluator): EvaluatorInternals {
  return evaluator as unknown as EvaluatorInternals;
}

function baseConfig(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return EvaluationConfigSchema.parse({
    enabled: true,
    ...overrides,
  });
}

function baseContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    originalGoal: 'What is the capital of France?',
    currentResponse: 'The capital of France is Paris.',
    conversationHistory: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'Looking that up…' },
      { role: 'assistant', content: 'The capital of France is Paris.' },
    ],
    refinementNumber: 0,
    stepsSoFar: 1,
    toolsAvailable: [],
    toolsUsed: [],
    ...overrides,
  };
}

const validEvalJson = JSON.stringify({
  sufficient: true,
  confidence: 0.95,
  reason: 'Fully answers the question',
  suggestedAction: 'finalize',
});

describe('LLMEvaluator', () => {
  describe('buildEvaluationMessages', () => {
    it('produces correct structure with original goal and current response', () => {
      const evaluator = new LLMEvaluator(new MockCompletionProvider(), baseConfig());
      const messages = asInternals(evaluator).buildEvaluationMessages(baseContext());

      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
      expect(messages[0]?.content).toContain('ORIGINAL REQUEST:');
      expect(messages[0]?.content).toContain('What is the capital of France?');
      expect(messages[0]?.content).toContain('RESPONSE TO EVALUATE:');
      expect(messages[0]?.content).toContain('The capital of France is Paris.');
      expect(messages[0]?.content).toContain('RECENT CONTEXT:');
      expect(messages[0]?.content).toContain('Assistant:');
    });

    it('includes refinement context when refinementNumber > 0', () => {
      const evaluator = new LLMEvaluator(
        new MockCompletionProvider(),
        baseConfig({ maxRefinements: 3 }),
      );
      const messages = asInternals(evaluator).buildEvaluationMessages(
        baseContext({ refinementNumber: 2 }),
      );

      expect(messages[0]?.content).toContain('refinement attempt 2 of 3');
    });
  });

  describe('parseResult', () => {
    it('handles valid JSON string', () => {
      const evaluator = new LLMEvaluator(new MockCompletionProvider(), baseConfig());
      const result = asInternals(evaluator).parseResult({ content: validEvalJson });

      expect(result.sufficient).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(result.reason).toBe('Fully answers the question');
      expect(result.suggestedAction).toBe('finalize');
    });

    it('handles ContentBlock array (extracts text blocks)', () => {
      const evaluator = new LLMEvaluator(new MockCompletionProvider(), baseConfig());
      const result = asInternals(evaluator).parseResult({
        content: [
          { type: 'text', text: '{"sufficient":false,' },
          { type: 'tool_use', id: '1', name: 'noop', input: {} },
          {
            type: 'text',
            text: '"confidence":0.7,"reason":"Missing examples","missingAspects":["examples"],"suggestedAction":"refine_response"}',
          },
        ],
      });

      expect(result.sufficient).toBe(false);
      expect(result.confidence).toBe(0.7);
      expect(result.missingAspects).toEqual(['examples']);
      expect(result.suggestedAction).toBe('refine_response');
    });

    it('strips markdown fences', () => {
      const evaluator = new LLMEvaluator(new MockCompletionProvider(), baseConfig());
      const fenced = '```json\n' + validEvalJson + '\n```';
      const result = asInternals(evaluator).parseResult({ content: fenced });

      expect(result.sufficient).toBe(true);
      expect(result.confidence).toBe(0.95);
    });

    it('does partial parse on incomplete JSON object', () => {
      const evaluator = new LLMEvaluator(new MockCompletionProvider(), baseConfig());
      const result = asInternals(evaluator).parseResult({
        content: JSON.stringify({ sufficient: false }),
      });

      expect(result.sufficient).toBe(false);
      expect(result.confidence).toBe(0.5);
      expect(result.reason).toBe('Partial parse');
      expect(result.suggestedAction).toBe('finalize');
    });

    it('returns sufficient:true on complete parse failure (fail-safe)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const evaluator = new LLMEvaluator(new MockCompletionProvider(), baseConfig());
      const result = asInternals(evaluator).parseResult({ content: 'not valid json at all' });

      expect(result.sufficient).toBe(true);
      expect(result.confidence).toBe(0.5);
      expect(result.reason).toContain('Evaluation parse error');
      expect(result.suggestedAction).toBe('finalize');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('evaluate', () => {
    it('calls provider.complete with correct model and maxTokens', async () => {
      const provider = new MockCompletionProvider().enqueue(textCompletion(validEvalJson));
      const evaluator = new LLMEvaluator(
        provider,
        baseConfig({ model: 'claude-haiku-3.5', maxEvalTokens: 256 }),
      );

      await evaluator.evaluate(baseContext());

      expect(provider.completeCalls).toBe(1);
      expect(provider.lastCompleteParams?.model).toBe('claude-haiku-3.5');
      expect(provider.lastCompleteParams?.maxTokens).toBe(256);
    });

    it('passes temperature: 0', async () => {
      const provider = new MockCompletionProvider().enqueue(textCompletion(validEvalJson));
      const evaluator = new LLMEvaluator(provider, baseConfig());

      await evaluator.evaluate(baseContext());

      expect(provider.lastCompleteParams?.temperature).toBe(0);
    });

    it('includes criteria in system prompt when configured', async () => {
      const provider = new MockCompletionProvider().enqueue(textCompletion(validEvalJson));
      const evaluator = new LLMEvaluator(provider, baseConfig());
      const criteria = [
        'Answers all parts of the question',
        'Includes specific examples when asked',
      ];

      await evaluator.evaluate(baseContext({ criteria }));

      const systemPrompt = provider.lastCompleteParams?.systemPrompt ?? '';
      expect(systemPrompt).toContain('Evaluation criteria for this agent:');
      expect(systemPrompt).toContain('- Answers all parts of the question');
      expect(systemPrompt).toContain('- Includes specific examples when asked');
    });

    it('includes tool lists in system prompt when populated', async () => {
      const provider = new MockCompletionProvider().enqueue(textCompletion(validEvalJson));
      const evaluator = new LLMEvaluator(provider, baseConfig());

      await evaluator.evaluate(
        baseContext({
          toolsAvailable: ['search', 'calculator'],
          toolsUsed: ['search'],
        }),
      );

      const systemPrompt = provider.lastCompleteParams?.systemPrompt ?? '';
      expect(systemPrompt).toContain('Tools available to the agent: search, calculator');
      expect(systemPrompt).toContain('Tools already called in this run: search');
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  Reflector,
  evaluateResultLightweight,
  evaluateStepLightweight,
  shouldContinueLightweight,
} from '../../src/agent/reflector.js';
import type { AgentResult, AgentStep } from '../../src/types/agent.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

describe('Reflector', () => {
  describe('lightweight mode', () => {
    const reflector = new Reflector({ lightweight: true });

    it('evaluateStep treats tool steps as on track', async () => {
      const step: AgentStep = {
        type: 'tool_call',
        content: { id: '1', name: 'search', input: { q: 'test' } },
        timestamp: Date.now(),
      };

      const evaluation = await reflector.evaluateStep(step, 'Find information');
      expect(evaluation.onTrack).toBe(true);
      expect(evaluation.confidence).toBeGreaterThan(0);
    });

    it('evaluateStep detects tentative responses', async () => {
      const step: AgentStep = {
        type: 'response',
        content: { text: 'Still working on it...' },
        timestamp: Date.now(),
      };

      const evaluation = await reflector.evaluateStep(step, 'Explain gravity');
      expect(evaluation.suggestion).toBeDefined();
    });

    it('evaluateResult marks substantive final answers as goal met', async () => {
      const result: AgentResult = {
        response: 'In conclusion, the answer is 42 because of the deep reasoning involved here.',
        steps: [],
        totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metadata: { stopReason: 'completed' },
      };

      const evaluation = await reflector.evaluateResult(result, 'What is the meaning of life?');
      expect(evaluation.goalMet).toBe(true);
      expect(evaluation.quality).toBeGreaterThan(0);
    });

    it('shouldContinue stops after a final-looking response', async () => {
      const steps: AgentStep[] = [
        {
          type: 'response',
          content: {
            text: 'The answer is Paris. In conclusion, that is the capital of France.',
          },
          timestamp: Date.now(),
        },
      ];

      const cont = await reflector.shouldContinue(steps, 'Capital of France?');
      expect(cont).toBe(false);
    });

    it('shouldContinue continues when no final response yet', async () => {
      const steps: AgentStep[] = [
        {
          type: 'thinking',
          content: { content: [] },
          timestamp: Date.now(),
        },
      ];

      const cont = await reflector.shouldContinue(steps, 'Capital of France?');
      expect(cont).toBe(true);
    });
  });

  describe('LLM mode', () => {
    it('evaluateStep parses provider JSON', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion(
          JSON.stringify({ onTrack: false, confidence: 0.4, suggestion: 'Use search tool' }),
        ),
      );
      const reflector = new Reflector({ provider });

      const evaluation = await reflector.evaluateStep(
        { type: 'thinking', content: {}, timestamp: Date.now() },
        'Research topic X',
      );

      expect(evaluation.onTrack).toBe(false);
      expect(evaluation.suggestion).toBe('Use search tool');
    });

    it('evaluateResult parses provider JSON', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion(
          JSON.stringify({
            goalMet: true,
            quality: 0.9,
            missingAspects: [],
          }),
        ),
      );
      const reflector = new Reflector({ provider });

      const evaluation = await reflector.evaluateResult(
        {
          response: 'Done',
          steps: [],
          totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          metadata: { stopReason: 'completed' },
        },
        'Complete the task',
      );

      expect(evaluation.goalMet).toBe(true);
      expect(evaluation.quality).toBe(0.9);
    });

    it('evaluateStep falls back to lightweight heuristics on invalid JSON', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion('not valid json at all'),
      );
      const reflector = new Reflector({ provider });

      const evaluation = await reflector.evaluateStep(
        { type: 'tool_result', content: { success: true }, timestamp: Date.now() },
        'goal',
      );

      expect(evaluation.onTrack).toBe(true);
    });

    it('shouldContinue uses lightweight fallback when shouldContinue field is missing', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion(JSON.stringify({ reason: 'ambiguous' })),
      );
      const reflector = new Reflector({ provider });

      const steps: AgentStep[] = [
        {
          type: 'response',
          content: {
            text: 'In conclusion, the answer is Paris and that is the capital.',
          },
          timestamp: Date.now(),
        },
      ];

      const cont = await reflector.shouldContinue(steps, 'Capital?');
      expect(cont).toBe(false);
    });

    it('shouldContinue respects provider decision', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion(JSON.stringify({ shouldContinue: false, reason: 'done' })),
      );
      const reflector = new Reflector({ provider });

      const cont = await reflector.shouldContinue([], 'Any goal');
      expect(cont).toBe(false);
    });
  });

  describe('exported lightweight helpers', () => {
    it('evaluateStepLightweight works without class instance', () => {
      const evaluation = evaluateStepLightweight(
        { type: 'tool_result', content: { success: true }, timestamp: 0 },
        'goal',
      );
      expect(evaluation.onTrack).toBe(true);
    });

    it('evaluateResultLightweight works without class instance', () => {
      const evaluation = evaluateResultLightweight(
        {
          response: 'short',
          steps: [],
          totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          metadata: { stopReason: 'completed' },
        },
        'goal',
      );
      expect(evaluation.goalMet).toBe(false);
    });

    it('shouldContinueLightweight stops after repeated tool failures', () => {
      const steps: AgentStep[] = [
        {
          type: 'tool_result',
          content: { success: false },
          timestamp: 1,
        },
        {
          type: 'tool_result',
          content: { success: false },
          timestamp: 2,
        },
      ];
      expect(shouldContinueLightweight(steps, 'goal')).toBe(false);
    });
  });
});

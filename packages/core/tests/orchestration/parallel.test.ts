import { describe, expect, it } from 'vitest';
import { ParallelWorkflow } from '../../src/orchestration/parallel.js';
import { WorkflowTimeoutError } from '../../src/orchestration/runner.js';
import { Agent } from '../../src/agent/agent.js';
import { textCompletion } from '../fixtures/mock-provider.js';
import { createTextAgent, delay } from './helpers.js';

describe('ParallelWorkflow', () => {
  it('runs all branches concurrently', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeAgent = (name: string, response: string) => {
      const provider = {
        async complete() {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await delay(30);
          concurrent -= 1;
          return textCompletion(response, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
        },
        async *stream() {
          yield { type: 'done' as const, data: { stopReason: 'end_turn' } };
        },
        countTokens: async () => 1,
      };
      return new Agent({ name, provider });
    };

    const workflow = new ParallelWorkflow({
      branches: [
        { agent: makeAgent('a', 'A') },
        { agent: makeAgent('b', 'B') },
        { agent: makeAgent('c', 'C') },
      ],
      concurrency: 3,
    });

    const output = await workflow.run('shared input');

    expect(output.steps).toHaveLength(3);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(output.finalResult.response).toContain('[a]: A');
    expect(output.finalResult.response).toContain('[c]: C');
  });

  it('uses merge function when provided', async () => {
    const workflow = new ParallelWorkflow({
      branches: [
        { agent: createTextAgent('x', 'one') },
        { agent: createTextAgent('y', 'two') },
      ],
      merge: (steps) => ({
        response: steps.map((s) => s.result.response).join('+'),
        steps: [],
        totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metadata: { stopReason: 'completed' },
      }),
    });

    const output = await workflow.run('input');
    expect(output.finalResult.response).toBe('one+two');
  });

  it('applies branch fallback on timeout', async () => {
    const slowProvider = {
      async complete() {
        await delay(200);
        return textCompletion('late', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      },
      async *stream() {
        yield { type: 'done' as const, data: { stopReason: 'end_turn' } };
      },
      countTokens: async () => 1,
    };

    const workflow = new ParallelWorkflow({
      branches: [
        {
          agent: new Agent({ name: 'slow', provider: slowProvider }),
          timeoutMs: 50,
          fallback: () => ({
            response: 'fallback result',
            steps: [],
            totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            metadata: { stopReason: 'completed' },
          }),
        },
      ],
      config: {
        onError: () => 'continue',
      },
    });

    const output = await workflow.run('test');
    expect(output.steps[0]?.result.response).toBe('fallback result');
    expect(output.steps[0]?.error).toBeInstanceOf(WorkflowTimeoutError);
  });
});

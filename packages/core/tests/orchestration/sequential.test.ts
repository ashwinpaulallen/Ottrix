import { describe, expect, it } from 'vitest';
import { Reflector } from '../../src/agent/reflector.js';
import { SequentialWorkflow } from '../../src/orchestration/sequential.js';
import { WorkflowTimeoutError } from '../../src/orchestration/runner.js';
import {
  MockCompletionProvider,
  textCompletion,
} from '../fixtures/mock-provider.js';
import { Agent } from '../../src/agent/agent.js';
import { createTextAgent } from './helpers.js';

describe('SequentialWorkflow', () => {
  it('runs agents in order and maps inputs', async () => {
    const researcher = createTextAgent('researcher', 'Research findings about AI.');
    const writer = createTextAgent('writer', 'Final article draft.');

    const workflow = new SequentialWorkflow([
      {
        agent: researcher,
        inputMapper: ({ originalInput }) => `Research: ${originalInput}`,
      },
      {
        agent: writer,
        inputMapper: (_ctx, prev) => `Write an article based on: ${prev?.response ?? ''}`,
      },
    ]);

    const output = await workflow.run('quantum computing');

    expect(output.steps).toHaveLength(2);
    expect(output.steps[0]?.input).toBe('Research: quantum computing');
    expect(output.steps[1]?.input).toContain('Research findings about AI');
    expect(output.finalResult.response).toBe('Final article draft.');
  });

  it('stops early when reflector reports goal met', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(
        'In conclusion, the answer is complete and fully addresses your request with enough detail.',
      ),
    );

    const first = new Agent({
      name: 'solver',
      provider,
      reflector: new Reflector({ lightweight: true }),
    });
    const second = createTextAgent('unused', 'should not run');

    const workflow = new SequentialWorkflow([
      { agent: first },
      { agent: second },
    ]);

    const output = await workflow.run('Solve the problem');

    expect(output.earlyTerminated).toBe(true);
    expect(output.steps).toHaveLength(1);
  });

  it('propagates errors by default', async () => {
    const provider = new MockCompletionProvider();
    const failing = new Agent({ name: 'fail', provider });

    const workflow = new SequentialWorkflow([{ agent: failing }]);

    await expect(workflow.run('test')).rejects.toThrow(/no more complete/i);
  });

  it('respects per-step timeout', async () => {
    const provider = {
      async complete() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return textCompletion('late', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      },
      async *stream() {
        yield { type: 'done' as const, data: { stopReason: 'end_turn' } };
      },
      countTokens: async () => 1,
    };

    const slow = new Agent({ name: 'slow', provider });
    const workflow = new SequentialWorkflow([{ agent: slow }], { timeout: 50 });

    await expect(workflow.run('test')).rejects.toBeInstanceOf(WorkflowTimeoutError);
  });
});

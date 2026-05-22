import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import {
  CyclicDependencyError,
  DAGBuilder,
  DAGStepTimeoutError,
  DAGWorkflow,
  DAGWorkflowCancelledError,
  functionStep,
} from '../../src/orchestration/dag.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';
import { delay } from './helpers.js';

describe('DAGWorkflow', () => {
  it('runs a linear DAG in order (A → B → C)', async () => {
    const order: string[] = [];

    const workflow = new DAGWorkflow({
      steps: [
        functionStep('a', 'A', async () => {
          order.push('a');
          return 'A-out';
        }),
        functionStep(
          'b',
          'B',
          async (input) => {
            order.push('b');
            expect(input).toEqual({ a: 'A-out' });
            return 'B-out';
          },
          { dependencies: ['a'] },
        ),
        functionStep(
          'c',
          'C',
          async (input) => {
            order.push('c');
            expect(input).toEqual({ b: 'B-out' });
            return 'C-out';
          },
          { dependencies: ['b'] },
        ),
      ],
    });

    const result = await workflow.run('start');

    expect(order).toEqual(['a', 'b', 'c']);
    expect(result.outputs.c).toBe('C-out');
    expect(result.finalOutput).toBe('C-out');
  });

  it('runs a diamond DAG with parallel branches (A → B, A → C, B+C → D)', async () => {
    const startTimes = new Map<string, number>();
    const endTimes = new Map<string, number>();

    const track = (id: string) => ({
      start: () => startTimes.set(id, Date.now()),
      end: () => endTimes.set(id, Date.now()),
    });

    const workflow = new DAGWorkflow({
      steps: [
        functionStep('a', 'A', async () => {
          const t = track('a');
          t.start();
          await delay(20);
          t.end();
          return 'A-out';
        }),
        functionStep(
          'b',
          'B',
          async () => {
            const t = track('b');
            t.start();
            await delay(30);
            t.end();
            return 'B-out';
          },
          { dependencies: ['a'] },
        ),
        functionStep(
          'c',
          'C',
          async () => {
            const t = track('c');
            t.start();
            await delay(30);
            t.end();
            return 'C-out';
          },
          { dependencies: ['a'] },
        ),
        functionStep(
          'd',
          'D',
          async (input) => {
            const deps = input as { b: string; c: string };
            const t = track('d');
            t.start();
            expect(deps).toEqual({ b: 'B-out', c: 'C-out' });
            t.end();
            return { b: deps.b, c: deps.c };
          },
          { dependencies: ['b', 'c'] },
        ),
      ],
    });

    const result = await workflow.run();

    expect(result.outputs.d).toEqual({ b: 'B-out', c: 'C-out' });
    expect(startTimes.get('b')).toBeDefined();
    expect(startTimes.get('c')).toBeDefined();
    expect(startTimes.get('d')!).toBeGreaterThanOrEqual(endTimes.get('b')!);
    expect(startTimes.get('d')!).toBeGreaterThanOrEqual(endTimes.get('c')!);

    const bAndCOverlap =
      startTimes.get('b')! < endTimes.get('c')! && startTimes.get('c')! < endTimes.get('b')!;
    expect(bAndCOverlap).toBe(true);
  });

  it('skips conditional steps and passes undefined to dependents', async () => {
    const workflow = new DAGWorkflow({
      steps: [
        functionStep('a', 'A', async () => 'enabled'),
        functionStep(
          'b',
          'B',
          async () => 'should-not-run',
          {
            dependencies: ['a'],
            condition: (deps) => deps.a === 'enabled',
          },
        ),
        functionStep(
          'c',
          'C',
          async () => 'should-not-run',
          {
            dependencies: ['a'],
            condition: () => false,
          },
        ),
        functionStep(
          'd',
          'D',
          async (input) => input,
          { dependencies: ['b', 'c'] },
        ),
      ],
    });

    const result = await workflow.run();

    expect(result.skippedSteps).toEqual(['c']);
    expect(result.outputs.b).toBe('should-not-run');
    expect(result.outputs.c).toBeUndefined();
    expect(result.outputs.d).toEqual({ b: 'should-not-run', c: undefined });
  });

  it('cascades failures to dependent steps', async () => {
    const executed: string[] = [];

    const workflow = new DAGWorkflow({
      steps: [
        functionStep('a', 'A', async () => {
          executed.push('a');
          throw new Error('boom');
        }),
        functionStep(
          'b',
          'B',
          async () => {
            executed.push('b');
            return 'B-out';
          },
          { dependencies: ['a'] },
        ),
        functionStep(
          'c',
          'C',
          async () => {
            executed.push('c');
            return 'C-out';
          },
          { dependencies: ['b'] },
        ),
      ],
    });

    const result = await workflow.run();

    expect(executed).toEqual(['a']);
    expect(result.failedSteps).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(result.outputs.b).toBeUndefined();
    expect(result.outputs.c).toBeUndefined();
  });

  it('retries failed steps and succeeds on a later attempt', async () => {
    let attempts = 0;

    const workflow = new DAGWorkflow({
      steps: [
        functionStep(
          'a',
          'A',
          async (_input, context) => {
            attempts += 1;
            if (context.attempt === 0) {
              throw new Error('transient');
            }
            return 'recovered';
          },
          { retries: 1 },
        ),
      ],
    });

    const result = await workflow.run();

    expect(attempts).toBe(2);
    expect(result.outputs.a).toBe('recovered');
    expect(result.failedSteps).toEqual([]);
  });

  it('throws CyclicDependencyError for cyclic graphs', () => {
    expect(
      () =>
        new DAGWorkflow({
          steps: [
            functionStep('a', 'A', async () => 'a', { dependencies: ['b'] }),
            functionStep('b', 'B', async () => 'b', { dependencies: ['a'] }),
          ],
        }),
    ).toThrow(CyclicDependencyError);
  });

  it('runs independent steps sequentially when maxConcurrency is 1', async () => {
    const active: string[] = [];
    const maxActive: { value: number } = { value: 0 };

    const tracked = (id: string) => async () => {
      active.push(id);
      maxActive.value = Math.max(maxActive.value, active.length);
      await delay(25);
      active.splice(active.indexOf(id), 1);
      return id;
    };

    const workflow = new DAGWorkflow({
      maxConcurrency: 1,
      steps: [
        functionStep('a', 'A', tracked('a')),
        functionStep('b', 'B', tracked('b')),
        functionStep('c', 'C', tracked('c')),
      ],
    });

    await workflow.run();

    expect(maxActive.value).toBe(1);
  });

  it('times out long-running steps', async () => {
    const onStepError = vi.fn();

    const workflow = new DAGWorkflow({
      onStepError,
      steps: [
        functionStep(
          'slow',
          'Slow',
          async (_input, context) => {
            await delay(200);
            throwIfAborted(context.signal);
            return 'done';
          },
          { timeout: 50 },
        ),
        functionStep(
          'next',
          'Next',
          async () => 'next',
          { dependencies: ['slow'] },
        ),
      ],
    });

    const result = await workflow.run();

    expect(onStepError).toHaveBeenCalledWith('slow', expect.any(DAGStepTimeoutError));
    expect(result.failedSteps).toEqual(expect.arrayContaining(['slow', 'next']));
  });

  it('cancels running steps', async () => {
    const workflow = new DAGWorkflow({
      steps: [
        functionStep('slow', 'Slow', async (_input, context) => {
          await abortableDelay(500, context.signal);
          return 'done';
        }),
      ],
    });

    const runPromise = workflow.run();
    await delay(30);
    workflow.cancel();

    await expect(runPromise).rejects.toThrow(DAGWorkflowCancelledError);
    expect(workflow.isCancelled()).toBe(true);
  });

  it('uses inputMapper to transform dependency outputs', async () => {
    const workflow = new DAGBuilder()
      .addStep('fetch_data', {
        name: 'Fetch',
        execute: async () => 'raw-data',
      })
      .addStep('analyze', {
        name: 'Analyze',
        execute: async () => ({ score: 10 }),
        dependencies: ['fetch_data'],
      })
      .addStep('enrich', {
        name: 'Enrich',
        execute: async () => ({ tags: ['ai'] }),
        dependencies: ['fetch_data'],
      })
      .addStep('report', {
        name: 'Report',
        execute: async (input: { analysis: unknown; enrichment: unknown }) => input,
        dependencies: ['analyze', 'enrich'],
        inputMapper: (deps) => ({
          analysis: deps.analyze,
          enrichment: deps.enrich,
        }),
      })
      .build();

    const result = await workflow.run('initial');

    expect(result.outputs.report).toEqual({
      analysis: { score: 10 },
      enrichment: { tags: ['ai'] },
    });
    expect(result.finalOutput).toEqual(result.outputs.report);
  });

  it('fires onStepComplete for successful steps', async () => {
    const onStepComplete = vi.fn();

    const workflow = new DAGWorkflow({
      onStepComplete,
      steps: [functionStep('a', 'A', async () => 'done')],
    });

    await workflow.run();

    expect(onStepComplete).toHaveBeenCalledWith('a', 'done', expect.any(Number));
  });

  it('runs agentStep helper through the DAG engine', async () => {
    const { agentStep } = await import('../../src/orchestration/dag.js');
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('agent response', { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    );
    const agent = new Agent({ name: 'worker', provider });

    const workflow = new DAGWorkflow({
      steps: [
        functionStep('prep', 'Prep', async () => 'question'),
        {
          ...agentStep(agent, { id: 'agent', dependencies: ['prep'] }),
          inputMapper: (deps: Record<string, unknown>) => String(deps.prep),
        } as import('../../src/orchestration/dag-types.js').DAGStep,
      ],
    });

    const result = await workflow.run();

    expect(result.outputs.agent).toMatchObject({ response: 'agent response' });
    expect(provider.completeCalls).toBe(1);
  });
});

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DAGWorkflowCancelledError();
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DAGWorkflowCancelledError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort);
  });
}

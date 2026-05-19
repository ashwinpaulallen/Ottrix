import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { HierarchicalWorkflow } from '../../src/orchestration/hierarchical.js';
import { ParallelWorkflow } from '../../src/orchestration/parallel.js';
import { RouterWorkflow } from '../../src/orchestration/router.js';
import { SequentialWorkflow } from '../../src/orchestration/sequential.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { MockProvider, lightUsage, textCompletion, toolUseCompletion } from '../helpers/mock-provider.js';
import { delay } from '../helpers/mock-provider.js';
import { createQueuedAgent } from '../helpers/test-utils.js';

function createTextAgent(name: string, response: string): Agent {
  const provider = new MockProvider().enqueue(textCompletion(response, lightUsage));
  return new Agent({ name, provider });
}

describe('integration: multi-agent workflows', () => {
  it('runs SequentialWorkflow with two mock agents', async () => {
    const researcher = createTextAgent('researcher', 'Research: AI is advancing rapidly.');
    const writer = createTextAgent('writer', 'Article draft complete.');

    const workflow = new SequentialWorkflow([
      {
        agent: researcher,
        inputMapper: ({ originalInput }) => `Research topic: ${originalInput}`,
      },
      {
        agent: writer,
        inputMapper: (_ctx, prev) => `Write using: ${prev?.response ?? ''}`,
      },
    ]);

    const output = await workflow.run('quantum computing');

    expect(output.steps).toHaveLength(2);
    expect(output.steps[0]?.agentName).toBe('researcher');
    expect(output.steps[1]?.agentName).toBe('writer');
    expect(output.finalResult.response).toBe('Article draft complete.');
  });

  it('runs ParallelWorkflow with three mock agents concurrently', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeAgent = (name: string, response: string) => {
      const provider = {
        async complete() {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await delay(25);
          concurrent -= 1;
          return textCompletion(response, lightUsage);
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
        { agent: makeAgent('alpha', 'Alpha result') },
        { agent: makeAgent('beta', 'Beta result') },
        { agent: makeAgent('gamma', 'Gamma result') },
      ],
      concurrency: 3,
    });

    const output = await workflow.run('shared task');

    expect(output.steps).toHaveLength(3);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(output.finalResult.response).toContain('[alpha]: Alpha result');
    expect(output.finalResult.response).toContain('[gamma]: Gamma result');
  });

  it('routes RouterWorkflow input to the correct agent', async () => {
    const billing = createTextAgent('billing', 'Invoice processed.');
    const support = createTextAgent('support', 'Login help provided.');

    const workflow = new RouterWorkflow({
      route: (input) => (input.toLowerCase().includes('invoice') ? 'billing' : 'support'),
      agents: { billing, support },
    });

    const billingOut = await workflow.run('question about invoice #42');
    expect(billingOut.steps[0]?.agentName).toBe('billing');
    expect(billingOut.finalResult.response).toBe('Invoice processed.');

    const supportOut = await workflow.run('help with login');
    expect(supportOut.steps[0]?.agentName).toBe('support');
    expect(supportOut.finalResult.response).toBe('Login help provided.');
  });

  it('runs HierarchicalWorkflow with manager delegating to a worker', async () => {
    const registry = new ToolRegistry();

    const workerProvider = new MockProvider().enqueue(
      textCompletion('Worker found three relevant papers.', lightUsage),
    );
    const worker = createQueuedAgent(workerProvider, { name: 'researcher' });

    const managerProvider = new MockProvider()
      .enqueue(
        toolUseCompletion(
          [
            {
              id: 'tu_1',
              name: 'delegate',
              input: { worker: 'researcher', task: 'Find papers on transformers' },
            },
          ],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Manager synthesis of worker output.', lightUsage));

    const manager = createQueuedAgent(managerProvider, {
      name: 'manager',
      toolRegistry: registry,
    });

    const workflow = new HierarchicalWorkflow({
      manager,
      workers: { researcher: worker },
      toolRegistry: registry,
    });

    const output = await workflow.run('Produce a research brief');

    expect(output.steps.some((s) => s.agentName === 'researcher')).toBe(true);
    expect(output.finalResult.response).toContain('Manager synthesis');
    expect(workerProvider.completeCalls).toBe(1);
  });
});

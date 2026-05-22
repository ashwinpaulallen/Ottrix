import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { HierarchicalWorkflow } from '../../src/orchestration/hierarchical.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';
import { createTextAgent } from './helpers.js';

describe('HierarchicalWorkflow', () => {
  it('manager delegates to a worker via the delegate tool', async () => {
    const registry = new ToolRegistry();

    const workerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Worker completed the subtask.'),
    );
    const worker = new Agent({
      name: 'researcher',
      provider: workerProvider,
    });

    const managerProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            {
              id: 'tu_1',
              name: 'delegate',
              input: { worker: 'researcher', task: 'Find papers on transformers' },
            },
          ],
          { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        ),
      )
      .enqueue(textCompletion('Manager final answer synthesizing worker output.'));

    const manager = new Agent({
      name: 'manager',
      provider: managerProvider,
      toolRegistry: registry,
    });

    const workflow = new HierarchicalWorkflow({
      manager,
      workers: { researcher: worker },
      toolRegistry: registry,
    });

    const output = await workflow.run('Produce a research brief');

    expect(output.steps.length).toBeGreaterThanOrEqual(2);
    expect(output.steps.some((s) => s.agentName === 'researcher')).toBe(true);
    expect(output.finalResult.response).toContain('Manager final answer');
    expect(workerProvider.completeCalls).toBe(1);
  });

  it('supports nested hierarchical workers', async () => {
    const outerRegistry = new ToolRegistry();
    const innerRegistry = new ToolRegistry();

    const leaf = createTextAgent('leaf', 'Leaf worker output');

    const innerManagerProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([
          {
            id: 'tu_inner',
            name: 'delegate',
            input: { worker: 'leaf', task: 'Do leaf work' },
          },
        ]),
      )
      .enqueue(textCompletion('Inner manager done'));

    const innerManager = new Agent({
      name: 'inner-manager',
      provider: innerManagerProvider,
      toolRegistry: innerRegistry,
    });

    const innerWorkflow = new HierarchicalWorkflow({
      manager: innerManager,
      workers: { leaf },
      toolRegistry: innerRegistry,
    });

    const outerManagerProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([
          {
            id: 'tu_outer',
            name: 'delegate',
            input: { worker: 'team', task: 'Run inner team' },
          },
        ]),
      )
      .enqueue(textCompletion('Outer manager final'));

    const outerManager = new Agent({
      name: 'outer-manager',
      provider: outerManagerProvider,
      toolRegistry: outerRegistry,
    });

    const outer = new HierarchicalWorkflow({
      manager: outerManager,
      workers: { team: innerWorkflow },
      toolRegistry: outerRegistry,
    });

    const output = await outer.run('Coordinate the team');

    expect(output.finalResult.response).toContain('Outer manager final');
    expect(output.steps.some((s) => s.agentName === 'leaf')).toBe(true);
  });

  it('throws when manager has no ToolRegistry', () => {
    const manager = createTextAgent('manager', 'x');

    expect(
      () =>
        new HierarchicalWorkflow({
          manager,
          workers: { a: createTextAgent('a', 'y') },
        }),
    ).toThrow(/ToolRegistry/);
  });

  it('returns tool error when max delegations exceeded', async () => {
    const registry = new ToolRegistry();

    const workerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Worker output.'),
    );
    const worker = new Agent({
      name: 'researcher',
      provider: workerProvider,
    });

    const managerProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([
          {
            id: 'tu_1',
            name: 'delegate',
            input: { worker: 'researcher', task: 'First task' },
          },
        ]),
      )
      .enqueue(
        toolUseCompletion([
          {
            id: 'tu_2',
            name: 'delegate',
            input: { worker: 'researcher', task: 'Second task' },
          },
        ]),
      )
      .enqueue(textCompletion('Final answer after delegation limit.'));

    const manager = new Agent({
      name: 'manager',
      provider: managerProvider,
      toolRegistry: registry,
    });

    const workflow = new HierarchicalWorkflow({
      manager,
      workers: { researcher: worker },
      toolRegistry: registry,
      maxDelegations: 1,
    });

    const output = await workflow.run('Keep delegating');

    expect(output.steps.filter((step) => step.agentName === 'researcher')).toHaveLength(1);
    expect(workerProvider.completeCalls).toBe(1);
    expect(output.finalResult.response).toContain('Final answer after delegation limit');
  });

  it('returns tool error for unknown worker', async () => {
    const registry = new ToolRegistry();

    const managerProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([
          {
            id: 'tu_1',
            name: 'delegate',
            input: { worker: 'ghost', task: 'Do work' },
          },
        ]),
      )
      .enqueue(textCompletion('Recovered after unknown worker.'));

    const manager = new Agent({
      name: 'manager',
      provider: managerProvider,
      toolRegistry: registry,
    });

    const workflow = new HierarchicalWorkflow({
      manager,
      workers: { researcher: createTextAgent('researcher', 'Worker output.') },
      toolRegistry: registry,
    });

    const output = await workflow.run('Try delegating');

    expect(output.steps.some((step) => step.agentName === 'ghost')).toBe(false);
    expect(output.finalResult.response).toContain('Recovered after unknown worker');
  });
});

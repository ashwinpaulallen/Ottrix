import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import {
  createSupervisor,
  SupervisorWorkflow,
} from '../../src/orchestration/supervisor.js';
import type { CompletionParams, CompletionProvider, CompletionResult } from '../../src/types/provider.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';
import { createTextAgent, delay } from './helpers.js';

const lightUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

class DelayedCompletionProvider implements CompletionProvider {
  completeCalls = 0;
  lastCompleteParams?: CompletionParams;

  constructor(
    private readonly delayMs: number,
    private readonly result: CompletionResult,
  ) {}

  async complete(params: CompletionParams): Promise<CompletionResult> {
    this.completeCalls += 1;
    this.lastCompleteParams = params;
    await delay(this.delayMs);
    return this.result;
  }

  async countTokens(): Promise<number> {
    return 10;
  }
}

function createRegistrySupervisor(
  managerProvider: MockCompletionProvider,
  workers: Map<string, Agent>,
  options?: {
    maxDelegationRounds?: number;
    workerTimeout?: number;
    onDelegation?: Parameters<typeof SupervisorWorkflow>[0]['onDelegation'];
  },
): SupervisorWorkflow {
  const registry = new ToolRegistry();
  const supervisor = new Agent({
    name: 'supervisor',
    provider: managerProvider,
    toolRegistry: registry,
    systemPrompt: SupervisorWorkflow.buildWorkerSystemPrompt(workers),
  });

  return new SupervisorWorkflow({
    supervisor,
    workers,
    toolRegistry: registry,
    maxDelegationRounds: options?.maxDelegationRounds,
    workerTimeout: options?.workerTimeout,
    onDelegation: options?.onDelegation,
  });
}

describe('SupervisorWorkflow', () => {
  it('delegates to one worker, gets result, and synthesizes a final answer', async () => {
    const workerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Research findings on RLHF.', lightUsage),
    );
    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: workerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            {
              id: 'tu_1',
              name: 'delegate',
              input: { worker: 'researcher', task: 'Research RLHF basics' },
            },
          ],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Final blog post synthesizing RLHF research.', lightUsage));

    const workflow = createRegistrySupervisor(supervisorProvider, workers);
    const result = await workflow.run('Write a blog post about RLHF');

    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]?.worker).toBe('researcher');
    expect(result.delegations[0]?.result.response).toContain('Research findings');
    expect(result.finalResult.response).toContain('Final blog post');
    expect(result.totalTokens.totalTokens).toBeGreaterThan(0);
    expect(workerProvider.completeCalls).toBe(1);
  });

  it('delegates to multiple workers sequentially', async () => {
    const researcherProvider = new MockCompletionProvider().enqueue(
      textCompletion('Research notes.', lightUsage),
    );
    const writerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Draft paragraph.', lightUsage),
    );

    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: researcherProvider })],
      ['writer', new Agent({ name: 'writer', provider: writerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            {
              id: 'tu_1',
              name: 'delegate',
              input: { worker: 'researcher', task: 'Gather facts' },
            },
            {
              id: 'tu_2',
              name: 'delegate',
              input: { worker: 'writer', task: 'Write intro', context: 'Use research notes' },
            },
          ],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Combined final article.', lightUsage));

    const workflow = createRegistrySupervisor(supervisorProvider, workers);
    const result = await workflow.run('Write an article');

    expect(result.delegations).toHaveLength(2);
    expect(result.delegations.map((d) => d.worker)).toEqual(['researcher', 'writer']);
    expect(result.delegations[1]?.context).toBe('Use research notes');
    expect(researcherProvider.completeCalls).toBe(1);
    expect(writerProvider.completeCalls).toBe(1);
    expect(result.finalResult.response).toContain('Combined final article');
  });

  it('returns worker timeout errors to the supervisor so it can adapt', async () => {
    const slowProvider = new DelayedCompletionProvider(
      200,
      textCompletion('Should not arrive in time.', lightUsage),
    );
    const fastProvider = new MockCompletionProvider().enqueue(
      textCompletion('Fast retry result.', lightUsage),
    );

    let workerCallCount = 0;
    const adaptiveWorkerProvider: CompletionProvider = {
      completeCalls: 0,
      lastCompleteParams: undefined,
      async complete(params: CompletionParams) {
        workerCallCount += 1;
        if (workerCallCount === 1) {
          return slowProvider.complete(params);
        }
        return fastProvider.complete(params);
      },
      async countTokens() {
        return 10;
      },
    };

    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: adaptiveWorkerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'delegate', input: { worker: 'researcher', task: 'Slow task' } }],
          lightUsage,
        ),
      )
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_2', name: 'delegate', input: { worker: 'researcher', task: 'Retry quickly' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Adapted after timeout.', lightUsage));

    const workflow = createRegistrySupervisor(supervisorProvider, workers, {
      workerTimeout: 50,
    });

    const result = await workflow.run('Handle slow worker');

    expect(result.delegations[0]?.error).toContain('timed out');
    expect(result.delegations).toHaveLength(2);
    expect(result.delegations[1]?.result.response).toContain('Fast retry result');
    expect(result.finalResult.response).toContain('Adapted after timeout');
  });

  it('enforces max delegation rounds and forces the supervisor to respond', async () => {
    const workerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Worker output.', lightUsage),
    );
    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: workerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'delegate', input: { worker: 'researcher', task: 'First task' } }],
          lightUsage,
        ),
      )
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_2', name: 'delegate', input: { worker: 'researcher', task: 'Second task' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Final answer after round limit.', lightUsage));

    const workflow = createRegistrySupervisor(supervisorProvider, workers, {
      maxDelegationRounds: 1,
    });

    const result = await workflow.run('Keep delegating');

    expect(result.delegations).toHaveLength(1);
    expect(workerProvider.completeCalls).toBe(1);
    expect(result.finalResult.response).toContain('Final answer after round limit');
  });

  it('keeps worker conversations isolated from each other', async () => {
    const researcherProvider = new MockCompletionProvider().enqueue(
      textCompletion('Research only.', lightUsage),
    );
    const writerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Writing only.', lightUsage),
    );

    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: researcherProvider })],
      ['writer', new Agent({ name: 'writer', provider: writerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            {
              id: 'tu_1',
              name: 'delegate',
              input: { worker: 'researcher', task: 'SECRET_RESEARCH_TASK' },
            },
            {
              id: 'tu_2',
              name: 'delegate',
              input: { worker: 'writer', task: 'SECRET_WRITER_TASK' },
            },
          ],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Done.', lightUsage));

    const workflow = createRegistrySupervisor(supervisorProvider, workers);
    await workflow.run('Coordinate workers');

    const researcherInput = JSON.stringify(researcherProvider.lastCompleteParams?.messages ?? []);
    const writerInput = JSON.stringify(writerProvider.lastCompleteParams?.messages ?? []);

    expect(researcherInput).toContain('SECRET_RESEARCH_TASK');
    expect(researcherInput).not.toContain('SECRET_WRITER_TASK');
    expect(writerInput).toContain('SECRET_WRITER_TASK');
    expect(writerInput).not.toContain('SECRET_RESEARCH_TASK');
  });

  it('fires onDelegation when a worker completes', async () => {
    const onDelegation = vi.fn();
    const workerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Worker done.', lightUsage),
    );
    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: workerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'delegate', input: { worker: 'researcher', task: 'Do work' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Supervisor final.', lightUsage));

    const workflow = createRegistrySupervisor(supervisorProvider, workers, { onDelegation });
    await workflow.run('Go');

    expect(onDelegation).toHaveBeenCalledTimes(1);
    expect(onDelegation.mock.calls[0]?.[0]).toMatchObject({
      worker: 'researcher',
      task: 'Do work',
    });
  });

  it('enforces maxNestedDepth across nested SupervisorWorkflow workers', async () => {
    const leafProvider = new MockCompletionProvider().enqueue(
      textCompletion('leaf output', lightUsage),
    );
    const leaf = new Agent({ name: 'leaf', provider: leafProvider });

    const innerRegistry = new ToolRegistry();
    const inner = new SupervisorWorkflow({
      supervisor: new Agent({
        name: 'inner-supervisor',
        provider: new MockCompletionProvider()
          .enqueue(
            toolUseCompletion(
              [{ id: 'tu_1', name: 'delegate', input: { worker: 'leaf', task: 'work' } }],
              lightUsage,
            ),
          )
          .enqueue(textCompletion('inner done', lightUsage)),
        toolRegistry: innerRegistry,
        systemPrompt: SupervisorWorkflow.buildWorkerSystemPrompt(new Map([['leaf', leaf]])),
      }),
      workers: new Map([['leaf', leaf]]),
      toolRegistry: innerRegistry,
    });

    const outerRegistry = new ToolRegistry();
    const outer = new SupervisorWorkflow({
      supervisor: new Agent({
        name: 'outer-supervisor',
        provider: new MockCompletionProvider()
          .enqueue(
            toolUseCompletion(
              [{ id: 'tu_1', name: 'delegate', input: { worker: 'team', task: 'go' } }],
              lightUsage,
            ),
          )
          .enqueue(textCompletion('outer done', lightUsage)),
        toolRegistry: outerRegistry,
        systemPrompt: SupervisorWorkflow.buildWorkerSystemPrompt(new Map([['team', inner]])),
      }),
      workers: new Map([['team', inner]]),
      toolRegistry: outerRegistry,
      maxNestedDepth: 0,
    });

    const result = await outer.run('task');

    expect(result.delegations[0]?.error).toContain('nested delegation depth');
    expect(leafProvider.completeCalls).toBe(0);
  });

  it('throws when supervisor has no ToolRegistry', () => {
    const supervisor = createTextAgent('supervisor', 'x');

    expect(
      () =>
        new SupervisorWorkflow({
          supervisor,
          workers: new Map([['a', createTextAgent('a', 'y')]]),
        }),
    ).toThrow(/ToolRegistry/);
  });
});

describe('createSupervisor', () => {
  it('builds a supervisor with worker descriptions in the system prompt', async () => {
    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'delegate', input: { worker: 'writer', task: 'Draft intro' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Published post.', lightUsage));

    const writerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Intro paragraph.', lightUsage),
    );

    const pipeline = createSupervisor({
      provider: supervisorProvider,
      systemPrompt: 'You manage a content team.',
      workers: {
        researcher: {
          systemPrompt: 'You are a research expert.',
          description: 'Expert at finding and analyzing information',
        },
        writer: {
          systemPrompt: 'You are a writing expert.',
          description: 'Expert at crafting clear, engaging content',
          provider: writerProvider,
        },
      },
    });

    const result = await pipeline.run('Write a blog post about RLHF');

    const systemMessage = supervisorProvider.lastCompleteParams?.messages.find(
      (message) => message.role === 'system',
    );
    const systemText =
      typeof systemMessage?.content === 'string'
        ? systemMessage.content
        : '';

    expect(systemText).toContain('You manage a content team.');
    expect(systemText).toContain('researcher');
    expect(systemText).toContain('finding and analyzing information');
    expect(systemText).toContain("Use the 'delegate' tool");
    expect(result.delegations[0]?.worker).toBe('writer');
    expect(result.finalResult.response).toContain('Published post');
  });

  it('invokes onSupervisorThinking during the run loop', async () => {
    const thinkingCalls: string[] = [];
    let runCompleted = false;

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'delegate', input: { worker: 'writer', task: 'Draft intro' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Published post.', lightUsage));

    const writerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Intro paragraph.', lightUsage),
    );

    const pipeline = createSupervisor({
      provider: supervisorProvider,
      workers: {
        writer: {
          systemPrompt: 'You are a writing expert.',
          provider: writerProvider,
        },
      },
      onSupervisorThinking: (content) => {
        expect(runCompleted).toBe(false);
        thinkingCalls.push(content);
      },
    });

    await pipeline.run('Write a blog post');
    runCompleted = true;

    expect(thinkingCalls.length).toBeGreaterThan(0);
  });
});

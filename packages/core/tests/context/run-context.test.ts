import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../src/agent/agent.js';
import { DAGWorkflow, functionStep } from '../../src/orchestration/dag.js';
import { Telemetry, InMemoryExporter } from '../../src/observability/telemetry.js';
import {
  ContextNotAvailableError,
  RunContext,
  createTool,
  getRunContext,
  requireRunContext,
  runGeneratorWith,
  runWith,
  withStep,
} from '../../src/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';
import { createTestAgent } from '../helpers/test-utils.js';

const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

describe('RunContext', () => {
  it('runWith sets context and getRunContext retrieves it', async () => {
    await runWith({ runId: 'run-1', agentName: 'test-agent' }, async () => {
      expect(getRunContext()).toEqual({
        runId: 'run-1',
        agentName: 'test-agent',
      });
    });
  });

  it('returns undefined when no context is active', () => {
    expect(getRunContext()).toBeUndefined();
  });

  it('requireRunContext throws ContextNotAvailableError when no context is active', () => {
    expect(() => requireRunContext()).toThrow(ContextNotAvailableError);
    expect(() => requireRunContext()).toThrow(/RunContext is not available/);
  });

  it('nested runWith merges contexts with inner values winning', async () => {
    await runWith({ runId: 'outer', agentName: 'outer-agent', requestId: 'req-1' }, async () => {
      await runWith({ runId: 'inner', stepId: 'step-a' }, async () => {
        expect(getRunContext()).toEqual({
          runId: 'inner',
          agentName: 'outer-agent',
          requestId: 'req-1',
          stepId: 'step-a',
        });
      });

      expect(getRunContext()?.runId).toBe('outer');
      expect(getRunContext()?.stepId).toBeUndefined();
    });
  });

  it('propagates context across async boundaries', async () => {
    await runWith({ runId: 'async-run' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getRunContext()?.runId).toBe('async-run');

      await Promise.all([
        Promise.resolve().then(() => {
          expect(getRunContext()?.runId).toBe('async-run');
        }),
      ]);
    });
  });

  it('withStep returns merged context with stepId set', async () => {
    await runWith({ runId: 'workflow-1' }, async () => {
      await runWith(withStep('fetch-data'), async () => {
        expect(getRunContext()?.stepId).toBe('fetch-data');
        expect(getRunContext()?.runId).toBe('workflow-1');
      });
    });
  });

  it('withStep throws ContextNotAvailableError when called outside an active run', () => {
    expect(() => withStep('orphan-step')).toThrow(ContextNotAvailableError);
    expect(() => withStep('orphan-step')).toThrow(/active RunContext/);
  });

  it('isolates context between concurrent runs', async () => {
    const observed: Array<string | undefined> = [];

    await Promise.all([
      runWith({ runId: 'run-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observed.push(getRunContext()?.runId);
      }),
      runWith({ runId: 'run-b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.push(getRunContext()?.runId);
      }),
    ]);

    expect(observed).toContain('run-a');
    expect(observed).toContain('run-b');
    expect(observed).toHaveLength(2);
  });

  it('returns a frozen context that callers cannot mutate', async () => {
    await runWith({ runId: 'immutable-run' }, async () => {
      const snapshot = getRunContext();
      expect(Object.isFrozen(snapshot)).toBe(true);

      expect(() => {
        (snapshot as Record<string, unknown>).runId = 'leaked';
      }).toThrow(TypeError);

      expect(getRunContext()?.runId).toBe('immutable-run');
    });
  });

  it('supports RunContext.augment for typed extensions', async () => {
    type AppContext = RunContext.Augment<{
      orgId: string;
      projectId: string;
    }>;

    await runWith({ runId: 'run-1', orgId: 'org-9', projectId: 'proj-3' }, async () => {
      const ctx = RunContext.augment<AppContext>(requireRunContext());
      expect(ctx.orgId).toBe('org-9');
      expect(ctx.projectId).toBe('proj-3');
    });
  });
});

describe('runGeneratorWith', () => {
  it('propagates RunContext to the generator body across every yield', async () => {
    const observed: Array<string | undefined> = [];

    async function* producer(): AsyncGenerator<number, void, undefined> {
      observed.push(getRunContext()?.runId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield 1;
      observed.push(getRunContext()?.runId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield 2;
      observed.push(getRunContext()?.runId);
    }

    for await (const _ of runGeneratorWith({ runId: 'gen-run' }, producer)) {
      // body executes with no surrounding ALS; the consumer's context must be the
      // generator's, which means the producer must keep seeing 'gen-run'.
      void _;
    }

    expect(observed).toEqual(['gen-run', 'gen-run', 'gen-run']);
  });

  it('does not leak generator context to the outer consumer', async () => {
    async function* producer(): AsyncGenerator<number, void, undefined> {
      yield 1;
    }

    for await (const _ of runGeneratorWith({ runId: 'inner-gen' }, producer)) {
      void _;
      expect(getRunContext()).toBeUndefined();
    }
  });
});

describe('RunContext agent integration', () => {
  it('Agent.run() sets up RunContext automatically', async () => {
    let capturedRunId: string | undefined;
    let capturedAgentName: string | undefined;

    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Hello', usage),
    );

    const agent = createTestAgent({
      name: 'context-agent',
      provider,
      onStep: () => {
        capturedRunId = getRunContext()?.runId;
        capturedAgentName = getRunContext()?.agentName;
      },
    });

    await agent.run('hi');

    expect(capturedRunId).toBeDefined();
    expect(capturedAgentName).toBe('context-agent');
  });

  it('inherits outer RunContext from a workflow scope', async () => {
    let captured: ReturnType<typeof getRunContext> | undefined;

    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Done', usage),
    );

    const agent = createTestAgent({ name: 'nested-agent', provider });

    await runWith({ runId: 'workflow-run', requestId: 'req-42' }, async () => {
      await agent.run('hello');
      captured = getRunContext();
    });

    expect(captured?.runId).toBe('workflow-run');
    expect(captured?.requestId).toBe('req-42');
  });

  it('tools can access RunContext without an explicit parameter', async () => {
    let capturedRunId: string | undefined;

    const tool = createTool({
      name: 'context_echo',
      description: 'echoes run id',
      input: z.object({}),
      execute: async () => {
        capturedRunId = getRunContext()?.runId;
        return null;
      },
    });

    const registry = new ToolRegistry();
    registry.register(tool);

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([{ id: 'tu_1', name: 'context_echo', input: {} }], usage),
      )
      .enqueue(textCompletion('The run id was captured.', usage));

    const agent = createTestAgent({
      provider,
      toolRegistry: registry,
    });

    const result = await agent.run('capture context');
    expect(result.metadata.stopReason).toBe('completed');
    expect(capturedRunId).toBeDefined();
  });

  it('passes RunContext as second argument for two-parameter executors', async () => {
    let explicitCtx: ReturnType<typeof getRunContext> | undefined;

    const tool = createTool({
      name: 'legacy_ctx',
      description: 'legacy',
      input: z.object({}),
      execute: async (_input, ctx) => {
        explicitCtx = ctx;
        return ctx?.runId ?? null;
      },
    });

    const registry = new ToolRegistry();
    registry.register(tool);

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([{ id: 'tu_1', name: 'legacy_ctx', input: {} }], usage),
      )
      .enqueue(textCompletion('ok', usage));

    const agent = createTestAgent({ provider, toolRegistry: registry });
    await agent.run('test');

    expect(explicitCtx?.runId).toBeDefined();
    expect(explicitCtx?.agentName).toBe('test-agent');
  });

  it('isolates context between two concurrent agent.run() calls', async () => {
    const observed: string[] = [];

    function makeAgent(name: string): Agent {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion(`from ${name}`, usage),
      );
      return new Agent({
        name,
        provider,
        onStep: () => {
          const runId = getRunContext()?.runId;
          const agentName = getRunContext()?.agentName;
          if (runId && agentName) {
            observed.push(`${agentName}|${runId.slice(0, 8)}`);
          }
        },
      });
    }

    await Promise.all([makeAgent('alpha').run('hi'), makeAgent('beta').run('hi')]);

    const alphaIds = new Set(
      observed.filter((s) => s.startsWith('alpha|')).map((s) => s.split('|')[1]),
    );
    const betaIds = new Set(
      observed.filter((s) => s.startsWith('beta|')).map((s) => s.split('|')[1]),
    );

    expect(alphaIds.size).toBeGreaterThan(0);
    expect(betaIds.size).toBeGreaterThan(0);
    for (const id of alphaIds) {
      expect(betaIds.has(id)).toBe(false);
    }
  });
});

describe('RunContext streaming integration', () => {
  it('tools invoked from Agent.stream() see the active RunContext', async () => {
    let capturedRunId: string | undefined;
    let capturedAgentName: string | undefined;
    let capturedStepId: string | undefined;

    const tool = createTool({
      name: 'context_probe',
      description: 'records run context',
      input: z.object({}),
      execute: async () => {
        const ctx = getRunContext();
        capturedRunId = ctx?.runId;
        capturedAgentName = ctx?.agentName;
        capturedStepId = ctx?.stepId;
        return null;
      },
    });

    const registry = new ToolRegistry();
    registry.register(tool);

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'context_probe', input: {} }],
          usage,
        ),
      )
      .enqueue(textCompletion('done', usage));

    const agent = new Agent({
      name: 'stream-agent',
      provider,
      toolRegistry: registry,
    });

    for await (const _ of agent.stream('go')) {
      void _;
    }

    expect(capturedRunId).toBeDefined();
    expect(capturedAgentName).toBe('stream-agent');
    expect(capturedStepId).toMatch(/^step_\d+$/);
  });
});

describe('RunContext DAG integration', () => {
  it('DAGWorkflow.run() sets runId and step context on StepContext', async () => {
    const observed: Array<{
      runId?: string;
      stepId?: string;
      contextStepId?: string;
    }> = [];

    const workflow = new DAGWorkflow({
      steps: [
        functionStep('a', 'Step A', async (_input, context) => {
          observed.push({
            runId: context.runContext?.runId,
            stepId: context.runContext?.stepId,
            contextStepId: context.stepId,
          });
          return 'a-out';
        }),
      ],
    });

    await workflow.run('input', { workflowId: 'wf-123' });

    expect(observed).toEqual([
      {
        runId: 'wf-123',
        stepId: 'a',
        contextStepId: 'a',
      },
    ]);
  });
});

describe('RunContext telemetry integration', () => {
  it('spans inherit run.id and agent.name from RunContext (OTel dotted keys)', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });

    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Hello', usage),
    );

    const agent = new Agent({
      name: 'telemetry-agent',
      provider,
      telemetry,
    });

    await agent.run('hi');

    const agentSpan = exporter.spans.find((span) => span.name === 'agent.run');
    expect(agentSpan?.attributes['run.id']).toBeDefined();
    expect(agentSpan?.attributes['agent.name']).toBe('telemetry-agent');

    expect(agentSpan?.attributes.runId).toBeUndefined();
    expect(agentSpan?.attributes.agentName).toBeUndefined();
  });
});

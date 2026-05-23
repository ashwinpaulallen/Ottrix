import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import {
  BudgetGuardrail,
  configureBudgets,
  estimateCostUsd,
  periodBucket,
  setDefaultBudgetStore,
  type BudgetConfig,
} from '../../src/guardrails/budget.js';
import { InMemoryBudgetStore } from '../../src/guardrails/budget-store.js';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';
import { createGuardrails } from '../../src/guardrails/factory.js';
import { runWith } from '../../src/context/run-context.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const lightUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
const heavyUsage = { inputTokens: 500, outputTokens: 300, totalTokens: 800 };

function scopedConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    scopes: [
      {
        name: 'agent',
        source: 'agentDef',
        cap: { maxTokens: 100, maxCostUsd: 1, maxSteps: 5 },
        onBreach: 'terminate',
      },
      {
        name: 'run',
        source: (ctx) => ctx.runId,
        cap: { maxTokens: 500, maxCostUsd: 5 },
        onBreach: 'terminate',
      },
      {
        name: 'org',
        source: (ctx) => ctx.orgId as string,
        cap: { maxCostUsd: 10, period: 'month' },
        onBreach: 'terminate',
      },
      {
        name: 'global',
        source: () => 'global',
        cap: { maxCostUsd: 100, period: 'month' },
        onBreach: 'terminate',
      },
    ],
    onBreachDefault: 'terminate',
    store: new InMemoryBudgetStore(),
    ...overrides,
  };
}

describe('BudgetGuardrail (legacy flat options)', () => {
  it('tracks remaining budget', () => {
    const budget = new BudgetGuardrail({
      maxSteps: 5,
      maxTokenBudget: 1000,
      maxCostUsd: 1,
    });

    budget.recordUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });

    const remaining = budget.getRemainingBudget();
    expect(remaining.tokens.used).toBe(150);
    expect(remaining.tokens.remaining).toBe(850);
    expect(remaining.steps.remaining).toBe(5);
  });

  it('blocks when step budget is exceeded', async () => {
    const budget = new BudgetGuardrail({ maxSteps: 1 });
    const middleware = new GuardrailMiddleware([budget]);

    const first = await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'a',
      messages: [],
      params: { messages: [] },
    });
    expect(first.proceed).toBe(true);

    const second = await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'a',
      messages: [],
      params: { messages: [] },
    });
    expect(second.proceed).toBe(false);
    expect(second.reason).toMatch(/step budget/i);
  });

  it('blocks when token budget is exceeded', async () => {
    const budget = new BudgetGuardrail({ maxTokenBudget: 50 });
    const middleware = new GuardrailMiddleware([budget]);

    await middleware.afterLlm({
      phase: 'llm',
      timing: 'post',
      agentName: 'a',
      messages: [],
      params: { messages: [] },
      result: textCompletion('ok', { inputTokens: 30, outputTokens: 30, totalTokens: 60 }),
    });

    const next = await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'a',
      messages: [],
      params: { messages: [] },
    });

    expect(next.proceed).toBe(false);
    expect(next.reason).toMatch(/token budget/i);
  });

  it('estimates cost from per-1k rates', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      { inputPer1k: 0.01, outputPer1k: 0.02 },
    );
    expect(cost).toBeCloseTo(0.03);
  });
});

describe('BudgetUsageStore', () => {
  it('increment and getUsage work correctly', async () => {
    const store = new InMemoryBudgetStore();
    await store.increment('org:acme', { tokens: 100, costUsd: 0.5, steps: 1 });
    const usage = await store.getUsage('org:acme');
    expect(usage).toEqual({ tokens: 100, costUsd: 0.5, steps: 1 });
    await store.increment('org:acme', { tokens: 50, costUsd: 0.25, steps: 0 });
    expect(await store.getUsage('org:acme')).toEqual({ tokens: 150, costUsd: 0.75, steps: 1 });
  });

  it('reset clears scoped usage', async () => {
    const store = new InMemoryBudgetStore();
    await store.increment('run:abc', { tokens: 10, costUsd: 0.1, steps: 1 }, '2026-5');
    await store.reset('run:abc');
    expect(await store.getUsage('run:abc', '2026-5')).toEqual({ tokens: 0, costUsd: 0, steps: 0 });
  });
});

describe('Budget scope stack', () => {
  let store: InMemoryBudgetStore;

  beforeEach(() => {
    store = new InMemoryBudgetStore();
    setDefaultBudgetStore(store);
  });

  afterEach(() => {
    setDefaultBudgetStore(new InMemoryBudgetStore());
  });

  it('agent scope breaches at agent-level cap and terminates', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'agent',
            source: 'agentDef',
            cap: { maxTokens: 50 },
            onBreach: 'terminate',
          },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await runWith({ runId: 'run1', agentName: 'researcher' }, async () => {
      await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
        result: textCompletion('ok', { inputTokens: 30, outputTokens: 30, totalTokens: 60 }),
      });

      const blocked = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      expect(blocked.proceed).toBe(false);
      expect(blocked.reason).toMatch(/\[agent\]/);
    });
  });

  it('run scope shares budget across agents in the same workflow run', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'run',
            source: (ctx) => ctx.runId,
            cap: { maxTokens: 100 },
            onBreach: 'terminate',
          },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await runWith({ runId: 'workflow_run', agentName: 'agent_a' }, async () => {
      await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: 'agent_a',
        messages: [],
        params: { messages: [] },
        result: textCompletion('a', { inputTokens: 40, outputTokens: 40, totalTokens: 80 }),
      });
    });

    await runWith({ runId: 'workflow_run', agentName: 'agent_b' }, async () => {
      await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: 'agent_b',
        messages: [],
        params: { messages: [] },
        result: textCompletion('b', { inputTokens: 30, outputTokens: 30, totalTokens: 60 }),
      });

      const blocked = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'agent_b',
        messages: [],
        params: { messages: [] },
      });

      expect(blocked.proceed).toBe(false);
      expect(blocked.reason).toMatch(/\[run\]/);
    });
  });

  it('org scope shares budget across runs under the same orgId', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'org',
            source: (ctx) => ctx.orgId as string,
            cap: { maxCostUsd: 0.01 },
            onBreach: 'terminate',
          },
        ],
        defaultCostPer1k: { inputPer1k: 1, outputPer1k: 1 },
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    for (const runId of ['run_a', 'run_b']) {
      await runWith({ runId, orgId: 'org_123', agentName: 'worker' }, async () => {
        await middleware.afterLlm({
          phase: 'llm',
          timing: 'post',
          agentName: 'worker',
          messages: [],
          params: { messages: [] },
          result: textCompletion('x', { inputTokens: 6, outputTokens: 6, totalTokens: 12 }),
        });
      });
    }

    const blocked = await runWith({ runId: 'run_c', orgId: 'org_123', agentName: 'worker' }, async () =>
      middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'worker',
        messages: [],
        params: { messages: [] },
      }),
    );

    expect(blocked.proceed).toBe(false);
    expect(blocked.reason).toMatch(/\[org\]/);
  });

  it('first breach wins when inner scopes are checked first', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'agent',
            source: 'agentDef',
            cap: { maxTokens: 40 },
            onBreach: 'terminate',
          },
          {
            name: 'run',
            source: (ctx) => ctx.runId,
            cap: { maxTokens: 1000 },
            onBreach: 'terminate',
          },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await runWith({ runId: 'run1', agentName: 'researcher' }, async () => {
      await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
        result: textCompletion('ok', { inputTokens: 25, outputTokens: 25, totalTokens: 50 }),
      });

      const blocked = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      expect(blocked.proceed).toBe(false);
      expect(blocked.reason).toMatch(/\[agent\]/);
      expect(blocked.reason).not.toMatch(/\[run\]/);
    });
  });

  it('requestApproval action suspends instead of terminating', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'agent',
            source: 'agentDef',
            cap: { maxSteps: 1 },
            onBreach: 'requestApproval',
          },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await runWith({ runId: 'run1', agentName: 'researcher' }, async () => {
      await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      const suspended = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      expect(suspended.proceed).toBe(false);
      expect(suspended.suspended).toBe(true);
      expect(suspended.flags).toContain('budget:agent:approval_required');
    });
  });

  it('flag action allows the call to continue', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'agent',
            source: 'agentDef',
            cap: { maxSteps: 1 },
            onBreach: 'flag',
          },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await runWith({ runId: 'run1', agentName: 'researcher' }, async () => {
      await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      const flagged = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      expect(flagged.proceed).toBe(true);
      expect(flagged.flags.some((flag) => flag.includes('budget:agent'))).toBe(true);
    });
  });

  it('warn action logs and continues', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          {
            name: 'agent',
            source: 'agentDef',
            cap: { maxSteps: 1 },
            onBreach: 'warn',
          },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await runWith({ runId: 'run1', agentName: 'researcher' }, async () => {
      await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      const result = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'researcher',
        messages: [],
        params: { messages: [] },
      });

      expect(result.proceed).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    warnSpy.mockRestore();
  });

  it('period enforcement resets monthly org budget with mock timers', async () => {
    let now = Date.parse('2026-05-15T12:00:00Z');
    const store = new InMemoryBudgetStore({ now: () => now });
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        now: () => now,
        scopes: [
          {
            name: 'org',
            source: (ctx) => ctx.orgId as string,
            cap: { maxCostUsd: 0.01, period: 'month' },
            onBreach: 'terminate',
          },
        ],
        defaultCostPer1k: { inputPer1k: 1, outputPer1k: 1 },
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);
    const mayBucket = periodBucket('month', now);

    await runWith({ runId: 'run1', orgId: 'org_monthly', agentName: 'worker' }, async () => {
      await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: 'worker',
        messages: [],
        params: { messages: [] },
        result: textCompletion('x', { inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
      });
    });

    const blocked = await runWith({ runId: 'run2', orgId: 'org_monthly', agentName: 'worker' }, async () =>
      middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'worker',
        messages: [],
        params: { messages: [] },
      }),
    );
    expect(blocked.proceed).toBe(false);

    now = Date.parse('2026-06-01T00:00:00Z');
    const juneBucket = periodBucket('month', now);
    expect(juneBucket).not.toBe(mayBucket);

    const fresh = await runWith({ runId: 'run3', orgId: 'org_monthly', agentName: 'worker' }, async () =>
      middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: 'worker',
        messages: [],
        params: { messages: [] },
      }),
    );
    expect(fresh.proceed).toBe(true);
  });

  it('getRemainingBudget returns accurate remaining amounts', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [{ name: 'agent', source: 'agentDef', cap: { maxTokens: 200, maxSteps: 3 } }],
      }),
    );

    await runWith({ runId: 'run1', agentName: 'researcher' }, async () => {
      budget.recordUsage({ inputTokens: 50, outputTokens: 50, totalTokens: 100 });
      const remaining = budget.getRemainingBudget('agent');
      expect(remaining.tokens.used).toBe(100);
      expect(remaining.tokens.remaining).toBe(100);
      expect(remaining.steps.remaining).toBe(3);
    });
  });

  it('falls back to agent-only scope when RunContext is unavailable', async () => {
    const budget = new BudgetGuardrail(
      scopedConfig({
        store,
        scopes: [
          { name: 'agent', source: 'agentDef', cap: { maxTokens: 30 }, onBreach: 'terminate' },
          { name: 'run', source: (ctx) => ctx.runId, cap: { maxTokens: 1000 }, onBreach: 'terminate' },
        ],
      }),
    );
    const middleware = new GuardrailMiddleware([budget]);

    await middleware.afterLlm({
      phase: 'llm',
      timing: 'post',
      agentName: 'solo',
      messages: [],
      params: { messages: [] },
      result: textCompletion('ok', { inputTokens: 20, outputTokens: 20, totalTokens: 40 }),
    });

    const blocked = await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'solo',
      messages: [],
      params: { messages: [] },
    });

    expect(blocked.proceed).toBe(false);
    expect(blocked.reason).toMatch(/\[agent\]/);
  });

  it('configureBudgets sets global configuration', () => {
    const config = scopedConfig();
    configureBudgets(config);
    const budget = new BudgetGuardrail(config);
    expect(budget.getRemainingBudget().steps.used).toBe(0);
  });
});

describe('BudgetGuardrail with Agent', () => {
  it('stops the agent when token budget is exceeded via middleware', async () => {
    const { middleware, budget, config } = createGuardrails({
      agentName: 'budget-agent',
      budget: { maxTokenBudget: 100 },
    });

    const noop = new FunctionTool({
      name: 'noop',
      description: 'No-op',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });

    const provider = new MockCompletionProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'noop', input: {} }], heavyUsage))
      .enqueue(textCompletion('done', lightUsage));

    const registry = new ToolRegistry();
    registry.register(noop);

    const agent = new Agent({
      name: 'budget-agent',
      provider,
      toolRegistry: registry,
      guardrailMiddleware: middleware,
      guardrails: config,
      maxSteps: 10,
    });

    const result = await agent.run('run tools');

    expect(result.metadata.stopReason).toBe('token_budget');
    expect(result.metadata.warning).toMatch(/token budget/i);
    expect(budget?.getRemainingBudget().tokens.used).toBeGreaterThanOrEqual(800);
    expect(provider.completeCalls).toBe(1);
  });

  it('suspends the agent when requestApproval budget action triggers', async () => {
    const store = new InMemoryBudgetStore();
    const budget = new BudgetGuardrail({
      scopes: [
        { name: 'agent', source: 'agentDef', cap: { maxTokens: 1 }, onBreach: 'requestApproval' },
      ],
      onBreachDefault: 'requestApproval',
      store,
    });
    const middleware = new GuardrailMiddleware([budget]);

    const provider = new MockCompletionProvider().enqueue(textCompletion('first', lightUsage));

    const agent = new Agent({
      name: 'approval-agent',
      provider,
      toolRegistry: new ToolRegistry(),
      guardrailMiddleware: middleware,
      maxSteps: 5,
    });

    const result = await agent.run('keep going');
    expect(result.metadata.stopReason).toBe('guardrail');
    expect(result.metadata.warning).toMatch(/approval|budget/i);
    expect(provider.completeCalls).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { BudgetGuardrail, estimateCostUsd } from '../../src/guardrails/budget.js';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';
import { createGuardrails } from '../../src/guardrails/factory.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const lightUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
const heavyUsage = { inputTokens: 500, outputTokens: 300, totalTokens: 800 };

describe('BudgetGuardrail', () => {
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

  it('blocks when cost budget is exceeded', async () => {
    const budget = new BudgetGuardrail({
      maxCostUsd: 0.001,
      defaultCostPer1k: { inputPer1k: 1, outputPer1k: 1 },
    });
    const middleware = new GuardrailMiddleware([budget]);

    await middleware.afterLlm({
      phase: 'llm',
      timing: 'post',
      agentName: 'a',
      messages: [],
      params: { messages: [] },
      result: textCompletion('ok', { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }),
    });

    const next = await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'a',
      messages: [],
      params: { messages: [] },
    });

    expect(next.proceed).toBe(false);
    expect(next.code).toBe('cost_budget');
  });

  it('estimates cost from per-1k rates', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      { inputPer1k: 0.01, outputPer1k: 0.02 },
    );
    expect(cost).toBeCloseTo(0.03);
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
});

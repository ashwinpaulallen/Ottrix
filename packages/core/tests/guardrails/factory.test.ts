import { describe, expect, it } from 'vitest';
import { createGuardrails } from '../../src/guardrails/factory.js';

describe('createGuardrails', () => {
  it('builds middleware with budget and audit handlers', () => {
    const { middleware, budget, audit, config } = createGuardrails({
      agentName: 'factory-test',
      budget: { maxSteps: 3, maxTokenBudget: 500 },
      pii: { mode: 'detect' },
      contentFilter: { patterns: ['badword'], action: 'flag' },
      audit: { console: false },
    });

    expect(middleware.listHandlers().length).toBeGreaterThanOrEqual(4);
    expect(middleware.listHandlers().some((handler) => handler.name === 'prompt-injection')).toBe(true);
    expect(budget?.getRemainingBudget().steps.limit).toBe(3);
    expect(audit).toBeDefined();
    expect(config.maxTokenBudget).toBe(500);
    expect(config.inputValidators).toHaveLength(1);
  });

  it('includes prompt injection protection by default', () => {
    const { middleware } = createGuardrails({ agentName: 'default-guardrails' });
    expect(middleware.listHandlers().some((handler) => handler.name === 'prompt-injection')).toBe(true);
  });

  it('allows opting out of prompt injection', () => {
    const { middleware } = createGuardrails({ promptInjection: false });
    expect(middleware.listHandlers().some((handler) => handler.name === 'prompt-injection')).toBe(false);
  });
});

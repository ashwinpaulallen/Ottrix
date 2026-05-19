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

    expect(middleware.listHandlers().length).toBeGreaterThanOrEqual(3);
    expect(budget?.getRemainingBudget().steps.limit).toBe(3);
    expect(audit).toBeDefined();
    expect(config.maxTokenBudget).toBe(500);
    expect(config.inputValidators).toHaveLength(1);
  });
});

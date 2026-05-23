import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/guardrails/audit.js';
import { BudgetGuardrail } from '../../src/guardrails/budget.js';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';

describe('AuditLogger guardrail decisions', () => {
  it('records block decisions from middleware', async () => {
    const audit = new AuditLogger({ agentName: 'audited', console: false });
    const middleware = new GuardrailMiddleware([
      audit,
      new BudgetGuardrail({ maxSteps: 0 }),
    ]);

    await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'audited',
      messages: [],
      params: { messages: [] },
    });

    const decisions = audit.getLogs().filter((entry) => entry.type === 'guardrail_decision');
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0]?.details.action).toBe('block');
  });
});

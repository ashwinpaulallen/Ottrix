import { describe, expect, it } from 'vitest';
import { RouterWorkflow } from '../../src/orchestration/router.js';
import { createTextAgent } from './helpers.js';

describe('RouterWorkflow', () => {
  it('routes to the selected agent', async () => {
    const billing = createTextAgent('billing', 'Billing answer');
    const support = createTextAgent('support', 'Support answer');

    const workflow = new RouterWorkflow({
      route: (input) => (input.includes('invoice') ? 'billing' : 'support'),
      agents: { billing, support },
    });

    const billingResult = await workflow.run('question about invoice');
    expect(billingResult.steps[0]?.agentName).toBe('billing');
    expect(billingResult.finalResult.response).toBe('Billing answer');

    const supportResult = await workflow.run('help with login');
    expect(supportResult.steps[0]?.agentName).toBe('support');
    expect(supportResult.finalResult.response).toBe('Support answer');
  });

  it('uses fallback agent for unknown routes', async () => {
    const fallback = createTextAgent('fallback', 'Default handler');

    const workflow = new RouterWorkflow({
      route: () => 'unknown-key',
      agents: { fallback },
      fallbackAgent: fallback,
    });

    const output = await workflow.run('anything');
    expect(output.finalResult.response).toBe('Default handler');
    expect(output.steps[0]?.agentName).toBe('fallback');
  });

  it('throws when route misses and no fallback is configured', async () => {
    const workflow = new RouterWorkflow({
      route: () => 'missing',
      agents: { other: createTextAgent('other', 'x') },
    });

    await expect(workflow.run('test')).rejects.toThrow(/no agent for route/i);
  });
});

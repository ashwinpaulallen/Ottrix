import { describe, expect, it } from 'vitest';
import { createMockAgent } from 'ottrix/testing';
import { runAgent } from '../src/server-actions.js';

describe('runAgent', () => {
  it('calls agent.run and returns result', async () => {
    const agent = createMockAgent();
    const result = await runAgent(agent, 'hello');

    expect(result.response).toBeDefined();
  });

  it('sets RunContext when available', async () => {
    const agent = createMockAgent();
    await runAgent(agent, 'trace me', { runContext: { runId: 'action-run-1', orgId: 'acme' } });

    expect(agent.getLastRunContext()?.runId).toBe('action-run-1');
    expect(agent.getLastRunContext()?.orgId).toBe('acme');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import { JevAgentRouter, type RouterConfig } from '../src/router.js';

const agents = {
  shopping: { description: 'Helps customers find and buy products', keywords: ['buy', 'price'] },
  support: { description: 'Handles order issues and complaints' },
  returns: { description: 'Processes returns and refunds' },
} as const;

function routerConfig(
  overrides: Partial<RouterConfig<'shopping' | 'support' | 'returns'>> = {},
): RouterConfig<'shopping' | 'support' | 'returns'> {
  return {
    apiKey: 'test-key',
    agents: { ...agents },
    defaultAgent: 'support',
    ...overrides,
  };
}

function decision(agentName: string, confidence: number, latencyMs = 18) {
  return {
    answers: {
      agentName: { choice: agentName, confidence },
    },
    latencyMs,
  };
}

describe('JevAgentRouter', () => {
  let decide: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    decide = vi.spyOn(JevClient.prototype, 'decide');
  });

  afterEach(() => {
    decide.mockRestore();
  });

  it('routes to the agent Jev selects', async () => {
    decide.mockResolvedValue(decision('shopping', 0.91));
    const router = new JevAgentRouter(routerConfig());

    const result = await router.route('I want to buy shoes');

    expect(result.agentName.value).toBe('shopping');
    expect(result.confidence).toBe(0.91);
  });

  it('falls back to the default agent when confidence is below the escalation threshold', async () => {
    decide.mockResolvedValue(decision('shopping', 0.49, 22));
    const router = new JevAgentRouter(routerConfig());

    const result = await router.route('hmm');

    expect(result.agentName.value).toBe('support');
    expect(result.agentName.confidence).toBe(0.49);
    expect(result.confidence).toBe(0.49);
    expect(result.agentName.latencyMs).toBe(22);
  });

  it('includes agent descriptions in state', async () => {
    decide.mockResolvedValue(decision('support', 0.88));
    const router = new JevAgentRouter(routerConfig());

    await router.route('Where is my package?');

    const state = decide.mock.calls[0]?.[0]?.state as {
      userMessage: string;
      availableAgents: string;
      messageLength: number;
    };
    expect(state.userMessage).toBe('Where is my package?');
    expect(state.messageLength).toBe('Where is my package?'.length);
    expect(state.availableAgents).toBe(
      [
        'shopping: Helps customers find and buy products',
        'support: Handles order issues and complaints',
        'returns: Processes returns and refunds',
      ].join('\n'),
    );
  });

  it('includes every agent name as a choice option', async () => {
    decide.mockResolvedValue(decision('returns', 0.86));
    const router = new JevAgentRouter(routerConfig());

    await router.route('I need a refund');

    const questions = decide.mock.calls[0]?.[0]?.questions as {
      agentName: { criteria: Record<string, null> };
    };
    expect(questions.agentName.criteria).toEqual({
      shopping: null,
      support: null,
      returns: null,
    });
  });

  it('returns the default agent when Jev throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decide.mockRejectedValue(new Error('Jev unavailable'));
    const router = new JevAgentRouter(routerConfig());

    const result = await router.route('hello');

    expect(result.agentName.value).toBe('support');
    expect(result.confidence).toBe(0);
    expect(result.agentName.confidence).toBe(0);
    expect(result.agentName.latencyMs).toBeGreaterThanOrEqual(0);
    expect(warn).toHaveBeenCalledWith(
      '[ottrix:jev-router] Jev routing failed, using default agent:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('routeSimple() returns only the agent name', async () => {
    decide.mockResolvedValue(decision('shopping', 0.93));
    const router = new JevAgentRouter(routerConfig());

    await expect(router.routeSimple('I want to buy shoes')).resolves.toBe('shopping');
  });

  it('attaches confidence to the agentName decision', async () => {
    decide.mockResolvedValue(decision('returns', 0.87, 11));
    const router = new JevAgentRouter(routerConfig());

    const result = await router.route('I want to return this');

    expect(result.agentName).toEqual({
      value: 'returns',
      confidence: 0.87,
      latencyMs: 11,
    });
    expect(result.confidence).toBe(result.agentName.confidence);
  });
});

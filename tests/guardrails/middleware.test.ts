import { describe, expect, it } from 'vitest';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';
import type { GuardrailHandler } from '../../src/guardrails/types.js';
import { textCompletion } from '../fixtures/mock-provider.js';

describe('GuardrailMiddleware', () => {
  it('composes handlers in order and stops on first block', async () => {
    const order: string[] = [];
    const first: GuardrailHandler = {
      name: 'first',
      beforeLlm: async () => {
        order.push('first');
        return { action: 'flag', flags: ['checked'] };
      },
    };
    const second: GuardrailHandler = {
      name: 'second',
      beforeLlm: async () => {
        order.push('second');
        return { action: 'block', reason: 'blocked by second' };
      },
    };
    const third: GuardrailHandler = {
      name: 'third',
      beforeLlm: async () => {
        order.push('third');
        return;
      },
    };

    const middleware = new GuardrailMiddleware([first, second, third]);
    const result = await middleware.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'test',
      messages: [],
      params: { messages: [] },
    });

    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('second');
    expect(order).toEqual(['first', 'second']);
    expect(result.flags).toContain('checked');
  });

  it('modifies LLM output text in post hooks', async () => {
    const middleware = new GuardrailMiddleware([
      {
        name: 'redactor',
        afterLlm: async () => ({
          action: 'modify',
          modifiedText: 'sanitized response',
        }),
      },
    ]);

    const completion = textCompletion('secret data', {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

    const post = await middleware.afterLlm({
      phase: 'llm',
      timing: 'post',
      agentName: 'test',
      messages: [],
      params: { messages: [] },
      result: completion,
    });

    expect(post.proceed).toBe(true);
    expect(post.result?.content[0]).toEqual({ type: 'text', text: 'sanitized response' });
  });
});

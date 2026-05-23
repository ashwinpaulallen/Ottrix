import { describe, expect, it } from 'vitest';
import {
  MockProvider,
  lightUsage,
  heavyUsage,
  textCompletion,
  toolUseCompletion,
} from '../helpers/mock-provider.js';
import { calculatorTool, echoTool, noopTool } from '../helpers/mock-tools.js';
import {
  assertAgentCompleted,
  assertStopReason,
  createQueuedAgent,
} from '../helpers/test-utils.js';

describe('integration: agent basics', () => {
  it('answers a basic question with a text-only mock response', async () => {
    const provider = new MockProvider().enqueue(
      textCompletion('The capital of France is Paris.', lightUsage),
    );

    const agent = createQueuedAgent(provider, {
      systemPrompt: 'You are a helpful assistant.',
    });

    const result = await agent.run('What is the capital of France?');

    assertAgentCompleted(result, 'The capital of France is Paris.');
    expect(provider.completeCalls).toBe(1);
    expect(result.steps.some((s) => s.type === 'thinking')).toBe(true);
    expect(result.steps.some((s) => s.type === 'response')).toBe(true);
  });

  it('uses a single tool and produces a final answer', async () => {
    const provider = new MockProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'calculator', input: { expression: '2 + 3' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('The answer is 5.', lightUsage));

    const agent = createQueuedAgent(provider, { tools: [calculatorTool] });
    const result = await agent.run('What is 2 + 3?');

    assertAgentCompleted(result, 'The answer is 5.');
    expect(provider.completeCalls).toBe(2);
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(1);
    expect(result.steps.filter((s) => s.type === 'tool_result')).toHaveLength(1);
  });

  it('chains multiple tools across sequential LLM turns', async () => {
    const provider = new MockProvider()
      .enqueue(
        toolUseCompletion([{ id: 'tu_1', name: 'echo', input: { message: 'step-one' } }], lightUsage),
      )
      .enqueue(
        toolUseCompletion([{ id: 'tu_2', name: 'echo', input: { message: 'step-two' } }], lightUsage),
      )
      .enqueue(textCompletion('Both echoes completed.', lightUsage));

    const agent = createQueuedAgent(provider, { tools: [echoTool] });
    const result = await agent.run('Run two echo steps');

    assertAgentCompleted(result, 'Both echoes completed.');
    expect(provider.completeCalls).toBe(3);
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(2);
  });

  it('stops when max steps is reached', async () => {
    const provider = new MockProvider();
    for (let i = 0; i < 6; i++) {
      provider.enqueue(
        toolUseCompletion([{ id: `tu_${i}`, name: 'noop', input: {} }], lightUsage),
      );
    }

    const agent = createQueuedAgent(provider, {
      tools: [noopTool],
      maxSteps: 2,
    });

    const result = await agent.run('Keep calling tools');

    assertStopReason(result, 'max_steps');
    expect(result.metadata.warning).toMatch(/Maximum steps/i);
    expect(provider.completeCalls).toBe(2);
  });

  it('stops when token budget is exceeded', async () => {
    const provider = new MockProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'noop', input: {} }], heavyUsage))
      .enqueue(textCompletion('should not reach', lightUsage));

    const agent = createQueuedAgent(provider, {
      tools: [noopTool],
      maxSteps: 10,
      maxTokenBudget: 100,
    });

    const result = await agent.run('Use tools until budget trips');

    assertStopReason(result, 'token_budget');
    expect(result.metadata.warning).toMatch(/[Tt]oken budget/i);
    expect(provider.completeCalls).toBe(1);
  });
});

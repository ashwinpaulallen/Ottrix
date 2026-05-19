import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { Planner } from '../../src/agent/planner.js';
import { Reflector } from '../../src/agent/reflector.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { AgentStep } from '../../src/types/agent.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

function createRegistry(tools: FunctionTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

const lightUsage: TokenUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
const heavyUsage: TokenUsage = { inputTokens: 500, outputTokens: 300, totalTokens: 800 };

describe('Agent.run', () => {
  it('answers a basic question without tools', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('The capital of France is Paris.', lightUsage),
    );

    const agent = new Agent({
      name: 'test',
      provider,
      systemPrompt: 'You are helpful.',
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.response).toBe('The capital of France is Paris.');
    expect(result.metadata.stopReason).toBe('completed');
    expect(result.totalTokens.totalTokens).toBe(8);
    expect(result.steps.some((s) => s.type === 'thinking')).toBe(true);
    expect(result.steps.some((s) => s.type === 'response')).toBe(true);
    expect(provider.completeCalls).toBe(1);
  });

  it('runs a single tool call cycle', async () => {
    const calculator = new FunctionTool({
      name: 'calculator',
      description: 'Adds numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: async (input) => {
        const a = typeof input.a === 'number' ? input.a : 0;
        const b = typeof input.b === 'number' ? input.b : 0;
        return a + b;
      },
    });

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([{ id: 'tu_1', name: 'calculator', input: { a: 2, b: 3 } }], lightUsage),
      )
      .enqueue(textCompletion('The sum is 5.', lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([calculator]),
    });

    const result = await agent.run('What is 2 + 3?');

    expect(result.response).toBe('The sum is 5.');
    expect(result.metadata.stopReason).toBe('completed');
    expect(provider.completeCalls).toBe(2);
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(1);
    expect(result.steps.filter((s) => s.type === 'tool_result')).toHaveLength(1);
  });

  it('handles multi-step tool use', async () => {
    const lookup = new FunctionTool({
      name: 'lookup',
      description: 'Looks up a value',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
      execute: async (input) => {
        const key = typeof input.key === 'string' ? input.key : '';
        return key === 'population' ? 8_000_000 : 'unknown';
      },
    });

    const format = new FunctionTool({
      name: 'format',
      description: 'Formats a number',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async (input) => {
        const value = typeof input.value === 'number' ? input.value : 0;
        return `${value.toLocaleString()} people`;
      },
    });

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'lookup', input: { key: 'population' } }],
          lightUsage,
        ),
      )
      .enqueue(
        toolUseCompletion([{ id: 'tu_2', name: 'format', input: { value: 8_000_000 } }], lightUsage),
      )
      .enqueue(textCompletion('The city has about 8,000,000 people.', lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([lookup, format]),
    });

    const result = await agent.run('How many people live there? Format nicely.');

    expect(result.response).toBe('The city has about 8,000,000 people.');
    expect(provider.completeCalls).toBe(3);
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(2);
  });

  it('stops when max steps is reached', async () => {
    const loopTool = new FunctionTool({
      name: 'loop',
      description: 'Keeps looping',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'again',
    });

    const provider = new MockCompletionProvider();
    for (let i = 0; i < 5; i++) {
      provider.enqueue(
        toolUseCompletion([{ id: `tu_${i}`, name: 'loop', input: {} }], lightUsage),
      );
    }

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([loopTool]),
      maxSteps: 2,
    });

    const result = await agent.run('Keep calling tools');

    expect(result.metadata.stopReason).toBe('max_steps');
    expect(result.metadata.warning).toContain('Maximum steps');
    expect(provider.completeCalls).toBe(2);
  });

  it('stops when token budget is exceeded', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'noop', input: {} }], heavyUsage))
      .enqueue(textCompletion('done', lightUsage));

    const noop = new FunctionTool({
      name: 'noop',
      description: 'No-op',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([noop]),
      maxSteps: 10,
      maxTokenBudget: 100,
    });

    const result = await agent.run('Use tools');

    expect(result.metadata.stopReason).toBe('token_budget');
    expect(result.metadata.warning).toContain('Token budget');
  });

  it('invokes onStep after each recorded step', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('Hi', lightUsage));
    const steps: AgentStep[] = [];

    const agent = new Agent({
      name: 'test',
      provider,
      onStep: (step) => steps.push(step),
    });

    await agent.run('Hello');

    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every((s) => s.timestamp > 0)).toBe(true);
  });

  it('onToolCall can block a tool execution', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'blocked', input: {} }], lightUsage))
      .enqueue(textCompletion('Could not run tool.', lightUsage));

    const blocked = new FunctionTool({
      name: 'blocked',
      description: 'Should not run',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('should not execute');
      },
    });

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([blocked]),
      onToolCall: () => false,
    });

    const result = await agent.run('Try the tool');

    expect(result.metadata.stopReason).toBe('tool_blocked');
  });

  it('onError skip continues after a failed tool', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'fail', input: {} }], lightUsage))
      .enqueue(textCompletion('Recovered.', lightUsage));

    const fail = new FunctionTool({
      name: 'fail',
      description: 'Always fails',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('tool broke');
      },
    });

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([fail]),
      onError: () => 'skip',
    });

    const result = await agent.run('Run failing tool');

    expect(result.response).toBe('Recovered.');
    expect(provider.completeCalls).toBe(2);
  });
});

describe('Agent.stream', () => {
  it('yields text and done events for a simple answer', async () => {
    const provider = new MockCompletionProvider().enqueueStream(
      textCompletion('Streaming hello.', lightUsage),
    );

    const agent = new Agent({ name: 'test', provider });
    const events = [];
    for await (const event of agent.stream('Hi')) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'text')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const doneData = done?.data as { response: string; stopReason: string };
    expect(doneData.response).toBe('Streaming hello.');
    expect(doneData.stopReason).toBe('completed');
  });

  it('yields tool_call and tool_result events', async () => {
    const echo = new FunctionTool({
      name: 'echo',
      description: 'Echoes',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
      execute: async (input) => {
        return typeof input.msg === 'string' ? input.msg : '';
      },
    });

    const provider = new MockCompletionProvider()
      .enqueueStream(toolUseCompletion([{ id: 'tu_1', name: 'echo', input: { msg: 'ping' } }]))
      .enqueueStream(textCompletion('pong', lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([echo]),
    });

    const types = [];
    for await (const event of agent.stream('echo ping')) {
      types.push(event.type);
    }

    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
  });
});

describe('Agent with Planner and Reflector', () => {
  it('injects plan into messages when planner is configured', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Here is the research summary.', lightUsage),
    );

    const planner = new Planner({ mode: 'rules' });
    const agent = new Agent({
      name: 'test',
      provider,
      planner,
    });

    const result = await agent.run('Please research climate trends');

    expect(result.metadata.plan).toBeDefined();
    expect(result.metadata.plan?.steps.length).toBeGreaterThan(1);
    expect(
      provider.lastCompleteParams?.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('Execution plan'),
      ),
    ).toBe(true);
    expect(result.response).toContain('research summary');
  });

  it('works without planner or reflector (basic ReAct)', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Plain answer.', lightUsage),
    );

    const agent = new Agent({ name: 'test', provider });
    const result = await agent.run('Hello');

    expect(result.metadata.plan).toBeUndefined();
    expect(result.metadata.resultEvaluation).toBeUndefined();
    expect(result.response).toBe('Plain answer.');
  });

  it('evaluates result when reflector is configured', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion('The final answer is 42.', lightUsage))
      .enqueue(
        textCompletion(JSON.stringify({ onTrack: true, confidence: 0.9 })),
      )
      .enqueue(
        textCompletion(JSON.stringify({ shouldContinue: false, reason: 'complete' })),
      )
      .enqueue(
        textCompletion(JSON.stringify({ goalMet: true, quality: 0.95 })),
      );

    const reflector = new Reflector({ provider });
    const agent = new Agent({
      name: 'test',
      provider,
      reflector,
    });

    const result = await agent.run('What is the answer?');

    expect(result.metadata.resultEvaluation).toBeDefined();
    expect(result.metadata.resultEvaluation?.goalMet).toBe(true);
    expect(result.response).toBe('The final answer is 42.');
  });

  it('does not stop early when reflector says stop but there is no final response', async () => {
    const calculator = new FunctionTool({
      name: 'calculator',
      description: 'Adds numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: async (input) => {
        const a = typeof input.a === 'number' ? input.a : 0;
        const b = typeof input.b === 'number' ? input.b : 0;
        return a + b;
      },
    });

    const provider = new MockCompletionProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'calculator', input: { a: 1, b: 2 } }], lightUsage))
      .enqueue(textCompletion(JSON.stringify({ onTrack: true, confidence: 0.9 })))
      .enqueue(textCompletion(JSON.stringify({ shouldContinue: false, reason: 'done' })))
      .enqueue(textCompletion('The sum is 3.', lightUsage))
      .enqueue(textCompletion(JSON.stringify({ onTrack: true, confidence: 0.9 })))
      .enqueue(textCompletion(JSON.stringify({ shouldContinue: false })))
      .enqueue(textCompletion(JSON.stringify({ goalMet: true, quality: 0.9 })));

    const reflector = new Reflector({ provider });
    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([calculator]),
      reflector,
    });

    const result = await agent.run('What is 1 + 2?');

    expect(result.response).toBe('The sum is 3.');
    expect(provider.completeCalls).toBeGreaterThan(2);
  });

  it('uses lightweight reflector without extra provider calls for evaluation', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(
        'In conclusion, the answer is Paris and that fully addresses your question about capitals.',
        lightUsage,
      ),
    );

    const reflector = new Reflector({ lightweight: true });
    const agent = new Agent({
      name: 'test',
      provider,
      reflector,
    });

    const result = await agent.run('What is the capital of France?');

    expect(provider.completeCalls).toBe(1);
    expect(result.metadata.resultEvaluation?.goalMet).toBe(true);
  });
});

describe('ContextManager', () => {
  it('summarizes when token count exceeds threshold', async () => {
    const provider = new MockCompletionProvider()
      .setTokenCount(200_000)
      .enqueue(textCompletion('Summary of earlier turns.', lightUsage));

    const { ContextManager } = await import('../../src/agent/context.js');
    const ctx = new ContextManager({
      provider,
      contextLimitTokens: 1000,
      keepRecentMessages: 2,
    });

    const messages = [
      { role: 'system' as const, content: 'System' },
      { role: 'user' as const, content: 'Old message 1' },
      { role: 'assistant' as const, content: 'Old reply 1' },
      { role: 'user' as const, content: 'Old message 2' },
      { role: 'assistant' as const, content: 'Old reply 2' },
      { role: 'user' as const, content: 'Recent 1' },
      { role: 'assistant' as const, content: 'Recent reply 1' },
    ];

    await ctx.maybeSummarize(messages);

    expect(messages.some((m) => String(m.content).includes('Conversation summary'))).toBe(true);
    expect(messages.length).toBeLessThan(7);
    expect(provider.completeCalls).toBe(1);
  });
});

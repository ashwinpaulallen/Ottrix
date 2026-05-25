import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { FunctionTool, WorkingMemory } from 'ottrix';
import { describe, expect, it } from 'vitest';

import { OttrixChatModel } from '../src/chat-model.js';
import {
  langChainMessagesToOttrix,
  ottrixMessagesToLangChain,
} from '../src/messages.js';
import { OttrixMemoryAdapter } from '../src/memory.js';
import { langChainToolsToOttrix, ottrixToolsToLangChain } from '../src/tools.js';
import { MockCompletionProvider, textCompletion, toolUseCompletion } from './mock-provider.js';

describe('OttrixChatModel', () => {
  it('returns llm type ottrix', () => {
    const model = new OttrixChatModel({ provider: new MockCompletionProvider() });
    expect(model._llmType()).toBe('ottrix');
  });

  it('_generate calls ottrix provider and returns ChatResult', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('hello world'));
    const model = new OttrixChatModel({ provider, modelId: 'mock-model' });

    const result = await model._generate(
      [new SystemMessage('You are helpful.'), new HumanMessage('Hi')],
      {},
    );

    expect(provider.completeCalls).toBe(1);
    expect(provider.lastCompleteParams?.model).toBe('mock-model');
    expect(provider.lastCompleteParams?.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(result.generations).toHaveLength(1);
    expect(result.generations[0]?.text).toBe('hello world');
    expect(result.generations[0]?.message).toBeInstanceOf(AIMessage);
  });

  it('maps tool calls in generate result', async () => {
    const provider = new MockCompletionProvider().enqueue(
      toolUseCompletion([{ id: 'call_1', name: 'lookup', input: { q: 'weather' } }]),
    );
    const model = new OttrixChatModel({ provider });

    const result = await model._generate([new HumanMessage('weather?')], {});
    const message = result.generations[0]?.message as AIMessage;
    expect(message.tool_calls).toEqual([
      { id: 'call_1', name: 'lookup', args: { q: 'weather' }, type: 'tool_call' },
    ]);
  });

  it('streams response chunks', async () => {
    const provider = new MockCompletionProvider().enqueueStream(
      textCompletion('streamed text', { inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
    );
    const model = new OttrixChatModel({ provider });

    const chunks = [];
    for await (const chunk of model._streamResponseChunks([new HumanMessage('go')], {})) {
      chunks.push(chunk);
    }

    expect(provider.streamCalls).toBe(1);
    expect(chunks.some((chunk) => chunk.text === 'streamed text')).toBe(true);
  });
});

describe('message translation', () => {
  it('roundtrips LangChain → ottrix → LangChain', () => {
    const original = [
      new SystemMessage('system prompt'),
      new HumanMessage('hello'),
      new AIMessage({
        content: 'calling tool',
        tool_calls: [{ id: '1', name: 'echo', args: { message: 'hi' }, type: 'tool_call' }],
      }),
      new ToolMessage({ content: '{"echoed":"hi"}', tool_call_id: '1' }),
    ];

    const ottrix = langChainMessagesToOttrix(original);
    expect(ottrix).toHaveLength(4);
    expect(ottrix[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(ottrix[1]).toEqual({ role: 'user', content: 'hello' });

    const roundtrip = ottrixMessagesToLangChain(ottrix);
    expect(roundtrip[0]).toBeInstanceOf(SystemMessage);
    expect(roundtrip[1]).toBeInstanceOf(HumanMessage);
    expect(roundtrip[2]).toBeInstanceOf(AIMessage);
    expect(roundtrip[3]).toBeInstanceOf(ToolMessage);
    expect((roundtrip[2] as AIMessage).tool_calls?.[0]?.name).toBe('echo');
    expect((roundtrip[3] as ToolMessage).tool_call_id).toBe('1');
  });
});

describe('tool conversion', () => {
  it('converts ottrix tools to LangChain and back', async () => {
    const echo = new FunctionTool({
      name: 'echo',
      description: 'Echo input',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      execute: async (input: Record<string, unknown>) => ({ echoed: input.message }),
    });

    const lcTools = ottrixToolsToLangChain([echo]);
    expect(lcTools[0]?.name).toBe('echo');
    await expect(lcTools[0]?.invoke({ message: 'hi' })).resolves.toEqual({ echoed: 'hi' });

    const ottrixTools = langChainToolsToOttrix([
      new DynamicStructuredTool({
        name: 'add',
        description: 'Adds numbers',
        schema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        func: async ({ a, b }: { a: number; b: number }) => a + b,
      }),
    ]);

    const result = await ottrixTools[0]!.execute({ a: 2, b: 3 });
    expect(result.success).toBe(true);
    expect(result.output).toBe(5);
  });
});

describe('OttrixMemoryAdapter', () => {
  it('reads and writes through WorkingMemory', async () => {
    const memory = new WorkingMemory();
    const history = new OttrixMemoryAdapter(memory);

    await history.addUserMessage('hello');
    await history.addAIChatMessage('hi there');

    const messages = await history.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[1]).toBeInstanceOf(AIMessage);
    expect(memory.getMessages()).toHaveLength(2);

    await history.clear();
    expect(await history.getMessages()).toHaveLength(0);
    expect(memory.getMessages()).toHaveLength(0);
  });
});

import { Agent, FunctionTool } from 'ottrix';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';

import { wrapOttrixAgent } from '../src/agent.js';
import { createOttrixMastraModel } from '../src/model.js';
import { mastraToolsToOttrix, ottrixToolsToMastra } from '../src/tools.js';
import { MockCompletionProvider, textCompletion } from './mock-provider.js';

describe('createOttrixMastraModel', () => {
  it('generates text via an ottrix provider', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('hello mastra', { inputTokens: 4, outputTokens: 3, totalTokens: 7 }),
    );
    const model = createOttrixMastraModel(provider, { modelId: 'test-model' });

    const result = await model.doGenerate({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi' }] }],
    });

    expect(provider.completeCalls).toBe(1);
    expect(provider.lastCompleteParams?.model).toBe('test-model');
    expect(result.text).toBe('hello mastra');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 3 });
  });
});

describe('tool conversion', () => {
  it('roundtrips ottrix tools through Mastra and back', async () => {
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

    const mastraTools = ottrixToolsToMastra([echo]);
    expect(mastraTools).toHaveLength(1);
    expect(mastraTools[0]!.id).toBe('echo');

    const mastraResult = await mastraTools[0]!.execute?.({ message: 'hi' }, {});
    expect(mastraResult).toEqual({ echoed: 'hi' });

    const ottrixTools = mastraToolsToOttrix([
      createTool({
        id: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        execute: async (inputData: unknown) => {
          const input = inputData as { message: string };
          return { echoed: input.message };
        },
      }),
    ]);

    expect(ottrixTools).toHaveLength(1);
    const result = await ottrixTools[0]!.execute({ message: 'again' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echoed: 'again' });
  });
});

describe('wrapOttrixAgent', () => {
  it('delegates generate() to the ottrix agent run loop', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('from ottrix', { inputTokens: 2, outputTokens: 4, totalTokens: 6 }),
    );
    const ottrixAgent = new Agent({ name: 'worker', provider });
    const mastraAgent = wrapOttrixAgent(ottrixAgent);

    const output = await mastraAgent.generate('run this');

    expect(provider.completeCalls).toBe(1);
    expect(output.text).toBe('from ottrix');
    expect(mastraAgent.id).toBe('worker');
  });
});

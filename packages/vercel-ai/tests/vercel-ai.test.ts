import { FunctionTool, ProviderError, ProviderRegistry } from 'ottrix';
import { jsonSchema } from 'ai';
import { describe, expect, it } from 'vitest';

import { createOttrixModel } from '../src/model.js';
import { createOttrixProvider } from '../src/registry.js';
import { ottrixToolsToVercel, vercelToolsToOttrix } from '../src/tools.js';
import { MockCompletionProvider, textCompletion, toolUseCompletion } from './mock-provider.js';

describe('createOttrixModel', () => {
  it('returns a valid LanguageModelV1', () => {
    const provider = new MockCompletionProvider();
    const model = createOttrixModel(provider, { modelId: 'test-model' });

    expect(model.specificationVersion).toBe('v1');
    expect(model.provider).toBe('ottrix');
    expect(model.modelId).toBe('test-model');
    expect(typeof model.doGenerate).toBe('function');
    expect(typeof model.doStream).toBe('function');
  });

  it('doGenerate calls provider.complete() and maps the response', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('hello world', { inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    );
    const model = createOttrixModel(provider, { modelId: 'mock-model' });

    const result = await model.doGenerate({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [
        { role: 'system', content: 'You are helpful.' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Say hi' }],
        },
      ],
    });

    expect(provider.completeCalls).toBe(1);
    expect(provider.lastCompleteParams?.model).toBe('mock-model');
    expect(provider.lastCompleteParams?.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Say hi' }] },
    ]);
    expect(result.text).toBe('hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
  });

  it('maps tool calls in doGenerate', async () => {
    const provider = new MockCompletionProvider().enqueue(
      toolUseCompletion([{ id: 'call_1', name: 'lookup', input: { q: 'weather' } }]),
    );
    const model = createOttrixModel(provider);

    const result = await model.doGenerate({
      inputFormat: 'messages',
      mode: {
        type: 'regular',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: 'Look things up',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
    });

    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([
      {
        toolCallType: 'function',
        toolCallId: 'call_1',
        toolName: 'lookup',
        args: JSON.stringify({ q: 'weather' }),
      },
    ]);
  });

  it('doStream produces a ReadableStream with text and finish parts', async () => {
    const provider = new MockCompletionProvider().enqueueStream(
      textCompletion('streamed', { inputTokens: 4, outputTokens: 6, totalTokens: 10 }),
    );
    const model = createOttrixModel(provider);

    const { stream } = await model.doStream({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    });

    expect(provider.streamCalls).toBe(1);

    const parts: Array<{ type: string }> = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    expect(parts.some((part) => part.type === 'text-delta')).toBe(true);
    expect(parts.some((part) => part.type === 'finish')).toBe(true);
    const textParts = parts.filter(
      (part): part is { type: 'text-delta'; textDelta: string } => part.type === 'text-delta',
    );
    expect(textParts.map((part) => part.textDelta).join('')).toBe('streamed');
  });
});

describe('createOttrixProvider', () => {
  it('routes generate calls through the registry fallback chain', async () => {
    const primary = new MockCompletionProvider('primary');
    primary.complete = async () => {
      throw new ProviderError('primary down', { code: 'server_error', retryable: true });
    };

    const backup = new MockCompletionProvider('backup');
    backup.enqueue(textCompletion('from backup'));

    const registry = new ProviderRegistry({ sleep: async () => undefined });
    registry.register('primary', primary);
    registry.register('backup', backup);
    registry.setFallbackChain([{ provider: 'primary' }, { provider: 'backup' }]);

    const ottrix = createOttrixProvider(registry);
    const model = ottrix('backup-model');
    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    expect(result.text).toBe('from backup');
    expect(backup.completeCalls).toBe(1);
  });
});

describe('tool conversion', () => {
  it('roundtrips ottrix tools through Vercel and back', async () => {
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

    const vercelTools = ottrixToolsToVercel([echo]);
    expect(vercelTools.echo).toBeDefined();
    expect(vercelTools.echo.description).toBe('Echo input');

    const vercelResult = await vercelTools.echo.execute?.({ message: 'hi' }, {
      toolCallId: '1',
      messages: [],
    });
    expect(vercelResult).toEqual({ echoed: 'hi' });

    const ottrixTools = vercelToolsToOttrix({
      echo: {
        description: 'Echo input',
        parameters: jsonSchema({
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        }),
        execute: async (args: { message: string }) => ({ echoed: args.message }),
      },
    });

    expect(ottrixTools).toHaveLength(1);
    const result = await ottrixTools[0]!.execute({ message: 'again' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echoed: 'again' });
  });
});

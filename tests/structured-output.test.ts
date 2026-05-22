import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent/agent.js';
import { StructuredOutputError } from '../src/agent/structured-output.js';
import {
  extractStructuredJsonText,
  parseAndValidateStructuredOutput,
  resolveStructuredOutputMaxAttempts,
} from '../src/agent/structured-output.js';
import { FunctionTool } from '../src/tools/function-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { TokenUsage } from '../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from './fixtures/mock-provider.js';

const lightUsage: TokenUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
});

describe('structured output helpers', () => {
  it('resolves max attempts as 1 + retry count', () => {
    expect(resolveStructuredOutputMaxAttempts(3)).toBe(4);
  });

  it('strips markdown json fences', () => {
    const inner = '{"name":"Ada","age":36,"email":"ada@example.com"}';
    expect(extractStructuredJsonText(`\`\`\`json\n${inner}\n\`\`\``)).toBe(inner);
  });

  it('validates nested objects, arrays, and enums', () => {
    const schema = z.object({
      summary: z.string(),
      sentiment: z.enum(['positive', 'negative', 'neutral']),
      confidence: z.number().min(0).max(1),
      keywords: z.array(z.string()).max(10),
    });

    const payload = {
      summary: 'Great product',
      sentiment: 'positive',
      confidence: 0.9,
      keywords: ['quality', 'fast'],
    };

    const result = parseAndValidateStructuredOutput(JSON.stringify(payload), schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(payload);
    }
  });
});

describe('Agent structured output', () => {
  it('returns parsedOutput for a valid JSON final response', async () => {
    const payload = { name: 'Ada Lovelace', age: 36, email: 'ada@example.com' };
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(JSON.stringify(payload), lightUsage),
    );

    const agent = new Agent({
      name: 'structured',
      provider,
      systemPrompt: 'You are helpful.',
    });

    const result = await agent.run('Introduce Ada', { outputSchema: personSchema });

    expect(result.parsedOutput).toEqual(payload);
    expect(result.response).toBe(JSON.stringify(payload));
    expect(result.metadata.stopReason).toBe('completed');
    expect(provider.completeCalls).toBe(1);
  });

  it('retries after invalid JSON and succeeds on the next attempt', async () => {
    const valid = { name: 'Grace Hopper', age: 85, email: 'grace@example.com' };
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion('not-json-at-all', lightUsage))
      .enqueue(textCompletion(JSON.stringify(valid), lightUsage));

    const agent = new Agent({
      name: 'structured-retry',
      provider,
      structuredOutputRetries: 3,
    });

    const result = await agent.run('Introduce Grace', { outputSchema: personSchema });

    expect(result.parsedOutput).toEqual(valid);
    expect(provider.completeCalls).toBe(2);
    expect(provider.lastCompleteParams?.responseFormat).toBe('text');
  });

  it('throws StructuredOutputError after exhausting retries', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion('still-not-json', lightUsage))
      .enqueue(textCompletion('{ "name": "X" }', lightUsage))
      .enqueue(textCompletion('nope', lightUsage))
      .enqueue(textCompletion('{"bad":true}', lightUsage));

    const agent = new Agent({
      name: 'structured-fail',
      provider,
      structuredOutputRetries: 3,
    });

    let caught: StructuredOutputError | undefined;
    try {
      await agent.run('Fail structured', { outputSchema: personSchema });
    } catch (error) {
      caught = error as StructuredOutputError;
    }

    expect(caught).toBeInstanceOf(StructuredOutputError);
    expect(caught?.attempts).toBe(4);
    expect(caught?.rawOutput).toBeTruthy();
    expect(caught?.zodErrors).toBeDefined();
    expect(provider.completeCalls).toBe(4);
  });

  it('parses JSON wrapped in prose in the final response', async () => {
    const payload = { name: 'Prose', age: 29, email: 'prose@example.com' };
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(`Here you go: ${JSON.stringify(payload)}`, lightUsage),
    );

    const agent = new Agent({ name: 'prose-json', provider });
    const result = await agent.run('Return JSON', { outputSchema: personSchema });

    expect(result.parsedOutput).toEqual(payload);
  });

  it('validates final JSON after tool calls without breaking the tool loop', async () => {
    const echo = new FunctionTool({
      name: 'echo',
      description: 'Echoes input',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async (input: Record<string, unknown>) => (typeof input.text === 'string' ? input.text : ''),
    });

    const payload = { name: 'Tool User', age: 30, email: 'tool@example.com' };
    const provider = new MockCompletionProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'echo', input: { text: 'hi' } }], lightUsage))
      .enqueue(textCompletion(JSON.stringify(payload), lightUsage));

    const agent = new Agent({
      name: 'structured-tools',
      provider,
      toolRegistry: new ToolRegistry().register(echo),
    });

    const result = await agent.run('Use echo then respond', { outputSchema: personSchema });

    expect(result.parsedOutput).toEqual(payload);
    expect(provider.completeCalls).toBe(2);
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(1);
    expect(result.steps.filter((s) => s.type === 'tool_result')).toHaveLength(1);
  });

  it('parses markdown-fenced JSON in the final response', async () => {
    const payload = { name: 'Fence Test', age: 22, email: 'fence@example.com' };
    const fenced = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const provider = new MockCompletionProvider().enqueue(textCompletion(fenced, lightUsage));

    const agent = new Agent({ name: 'fenced', provider });
    const result = await agent.run('Return fenced JSON', { outputSchema: personSchema });

    expect(result.parsedOutput).toEqual(payload);
  });

  it('appends structured output instructions to the system prompt', async () => {
    const payload = { name: 'Prompt', age: 40, email: 'prompt@example.com' };
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(JSON.stringify(payload), lightUsage),
    );

    const agent = new Agent({
      name: 'prompt-check',
      provider,
      systemPrompt: 'Base system prompt.',
    });

    await agent.run('Go', { outputSchema: personSchema });

    const systemMessage = provider.lastCompleteParams?.messages.find(
      (message) => message.role === 'system',
    );
    const systemText =
      typeof systemMessage?.content === 'string'
        ? systemMessage.content
        : systemMessage?.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('') ?? '';

    expect(systemText).toContain('Base system prompt.');
    expect(systemText).toContain('you MUST respond with a JSON object matching this schema');
    expect(systemText).toContain('"name"');
    expect(provider.lastCompleteParams?.systemPrompt).toBeUndefined();
  });

  it('uses config-level outputSchema when run options omit it', async () => {
    const payload = { name: 'Config', age: 21, email: 'config@example.com' };
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(JSON.stringify(payload), lightUsage),
    );

    const agent = new Agent({
      name: 'config-schema',
      provider,
      outputSchema: personSchema,
    });

    const result = await agent.run('Go');
    expect(result.parsedOutput).toEqual(payload);
  });
});

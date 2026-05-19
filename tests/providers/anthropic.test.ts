import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_COUNT_TOKENS_URL,
  AnthropicProvider,
  createAnthropicProvider,
} from '../../src/providers/anthropic.js';
import { ProviderError } from '../../src/providers/errors.js';
import type { ChatMessage } from '../../src/types/messages.js';

const API_KEY = 'test-api-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: Array<{ event: string; data: Record<string, unknown> }>): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify({ type: e.event, ...e.data })}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('createAnthropicProvider', () => {
  it('returns an AnthropicProvider instance with default model', () => {
    const provider = createAnthropicProvider({ apiKey: API_KEY });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});

describe('AnthropicProvider.complete', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends required headers and maps the response', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: ANTHROPIC_DEFAULT_MODEL,
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(result.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  });

  it('places system prompt in top-level system field, not in messages', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: ANTHROPIC_DEFAULT_MODEL,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];

    await provider.complete({
      messages,
      systemPrompt: 'Extra system context.',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      system: string;
      messages: { role: string }[];
    };

    expect(body.system).toBe('Extra system context.\n\nYou are helpful.');
    expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('translates tool definitions to Anthropic tool format', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: ANTHROPIC_DEFAULT_MODEL,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await provider.complete({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      tools: Array<{ name: string; description: string; input_schema: unknown }>;
    };

    expect(body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather for a city',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ]);
  });

  it('translates tool_result blocks for tool-role messages', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        model: ANTHROPIC_DEFAULT_MODEL,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await provider.complete({
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '72°F' }],
        },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: unknown[] }>;
    };

    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '72°F' }],
    });
  });
});

describe('AnthropicProvider errors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [401, 'auth', false],
    [429, 'rate_limit', true],
    [529, 'server_error', true],
  ] as const)('maps HTTP %i to ProviderError code=%s retryable=%s', async (status, code, retryable) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { type: 'error', message: `HTTP ${status}` } }, status),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({
      code,
      retryable,
    });
  });
});

describe('AnthropicProvider.stream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses SSE events into StreamChunk objects', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sseResponse([
        {
          event: 'message_start',
          data: { message: { usage: { input_tokens: 5 } } },
        },
        {
          event: 'content_block_delta',
          data: { index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        },
        {
          event: 'message_delta',
          data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        },
        { event: 'message_stop', data: {} },
      ]),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const chunks = [];
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'text_delta', data: { text: 'Hello' } }),
    );
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      data: { stopReason: 'end_turn' },
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      stream: boolean;
    };
    expect(body.stream).toBe(true);
  });

  it('yields tool_use stream chunks for tool blocks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sseResponse([
        { event: 'message_start', data: { message: { usage: { input_tokens: 1 } } } },
        {
          event: 'content_block_start',
          data: {
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"city":' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '"NYC"}' },
          },
        },
        { event: 'content_block_stop', data: { index: 0 } },
        { event: 'message_stop', data: {} },
      ]),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const chunks = [];
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'weather?' }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_start',
        data: { id: 'toolu_1', name: 'get_weather' },
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_end',
        data: { id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
      }),
    );
  });
});

describe('AnthropicProvider.countTokens', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Anthropic count_tokens endpoint and returns input_tokens', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ input_tokens: 42 }));

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const count = await provider.countTokens([{ role: 'user', content: 'Hello' }]);

    expect(count).toBe(42);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(ANTHROPIC_COUNT_TOKENS_URL);
  });

  it('throws ProviderError on auth failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { message: 'invalid x-api-key' } }, 401),
    );

    const provider = createAnthropicProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await expect(provider.countTokens([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

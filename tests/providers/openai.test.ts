import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OpenAIProvider,
  createOpenAIProvider,
} from '../../src/providers/openai.js';
import { ProviderError } from '../../src/providers/errors.js';
const API_KEY = 'test-api-key';
const COMPLETIONS_URL = `${OPENAI_DEFAULT_BASE_URL}/chat/completions`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openaiSseResponse(chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat('data: [DONE]\n\n')
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('createOpenAIProvider', () => {
  it('returns an OpenAIProvider instance', () => {
    const provider = createOpenAIProvider({ apiKey: API_KEY });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.chatCompletionsUrl).toBe(COMPLETIONS_URL);
  });

  it('supports custom baseUrl for compatible endpoints', () => {
    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    expect(provider.chatCompletionsUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
  });
});

describe('OpenAIProvider.complete', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends Bearer auth and maps choices to CompletionResult', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(COMPLETIONS_URL);

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(OPENAI_DEFAULT_MODEL);
    expect(body.stream).toBe(false);

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });

  it('keeps system messages as role system and prepends systemPrompt', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await provider.complete({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      systemPrompt: 'Extra instructions.',
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(body.messages[0]).toEqual({ role: 'system', content: 'Extra instructions.' });
    expect(body.messages[1]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(body.messages[2]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('translates tools to OpenAI function calling format', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await provider.complete({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ],
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      tools: Array<{ type: string; function: { name: string; parameters: unknown } }>;
    };

    expect(body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    });
  });

  it('maps assistant tool_calls to tool_use blocks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'weather?' }],
    });

    expect(result.stopReason).toBe('tool_calls');
    expect(result.content).toContainEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'NYC' },
    });
  });

  it('maps tool role messages to role tool with tool_call_id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await provider.complete({
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '72°F' }],
        },
      ],
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; tool_call_id: string; content: string }>;
    };

    expect(body.messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '72°F',
    });
  });
});

describe('OpenAIProvider errors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [401, 'auth', false],
    [429, 'rate_limit', true],
    [413, 'context_length', false],
  ] as const)('maps HTTP %i to ProviderError code=%s', async (status, code, retryable) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { message: `error ${status}` } }, status),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ code, retryable });
  });
});

describe('OpenAIProvider.stream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses SSE chunks and terminates on [DONE]', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      openaiSseResponse([
        {
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ]),
    );

    const provider = createOpenAIProvider({
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
      data: { stopReason: 'stop' },
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      stream: boolean;
    };
    expect(body.stream).toBe(true);
  });

  it('streams tool call deltas', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      openaiSseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"city":"LA"}' } }],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
      ]),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const chunks = [];
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'weather' }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_start',
        data: { id: 'call_1', name: 'get_weather' },
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_end',
        data: { id: 'call_1', name: 'get_weather', input: { city: 'LA' } },
      }),
    );
  });
});

describe('OpenAIProvider.countTokens', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns prompt_tokens from usage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 55, completion_tokens: 1, total_tokens: 56 },
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const count = await provider.countTokens([{ role: 'user', content: 'Hello' }]);
    expect(count).toBe(55);
  });

  it('throws ProviderError when usage is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: 'chatcmpl-1',
        model: OPENAI_DEFAULT_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '.' },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = createOpenAIProvider({
      apiKey: API_KEY,
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    await expect(provider.countTokens([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

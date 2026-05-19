import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OllamaProvider,
  createOllamaProvider,
} from '../../src/providers/ollama.js';
import { ProviderError } from '../../src/providers/errors.js';

const CHAT_URL = `${OLLAMA_DEFAULT_BASE_URL}/api/chat`;
const TAGS_URL = `${OLLAMA_DEFAULT_BASE_URL}/api/tags`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

describe('createOllamaProvider', () => {
  it('returns an OllamaProvider with defaults', () => {
    const provider = createOllamaProvider();
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.chatUrl).toBe(CHAT_URL);
  });
});

describe('OllamaProvider.listModels', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches /api/tags and returns model info', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            name: 'llama3.1:latest',
            model: 'llama3.1:latest',
            modified_at: '2024-01-01T00:00:00Z',
            size: 4_000_000_000,
          },
        ],
      }),
    );

    const models = await OllamaProvider.listModels();
    expect(fetch).toHaveBeenCalledWith(TAGS_URL);
    expect(models).toEqual([
      {
        name: 'llama3.1:latest',
        model: 'llama3.1:latest',
        modifiedAt: '2024-01-01T00:00:00Z',
        size: 4_000_000_000,
      },
    ]);
  });
});

describe('OllamaProvider.healthCheck', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok when the server responds', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Ollama is running', { status: 200 }),
    );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });
    const health = await provider.healthCheck();

    expect(fetch).toHaveBeenCalledWith(OLLAMA_DEFAULT_BASE_URL, { method: 'GET' });
    expect(health.ok).toBe(true);
    expect(health.version).toBe('Ollama is running');
  });

  it('returns not ok when the server is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = createOllamaProvider();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
  });
});

describe('OllamaProvider.complete', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Ollama chat response to CompletionResult with eval counts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        model: OLLAMA_DEFAULT_MODEL,
        message: { role: 'assistant', content: 'Hello!' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 12,
        eval_count: 4,
      }),
    );

    const provider = createOllamaProvider({
      requestsPerMinute: 10_000,
      maxRetries: 0,
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CHAT_URL);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(OLLAMA_DEFAULT_MODEL);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  });

  it('prepends systemPrompt and keeps system role messages', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        model: OLLAMA_DEFAULT_MODEL,
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });

    await provider.complete({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
      systemPrompt: 'Extra rules.',
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(body.messages[0]).toEqual({ role: 'system', content: 'Extra rules.' });
    expect(body.messages[1]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(body.messages[2]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('retries without tools when the model does not support them', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ error: 'model does not support tools' }, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model: OLLAMA_DEFAULT_MODEL,
          message: { role: 'assistant', content: 'no tools' },
          done: true,
          prompt_eval_count: 2,
          eval_count: 3,
        }),
      );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'ping',
          description: 'Ping',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetch).mock.calls;
    const firstBody = JSON.parse((calls[0][1] as RequestInit).body as string) as {
      tools?: unknown;
    };
    const secondBody = JSON.parse((calls[1][1] as RequestInit).body as string) as {
      tools?: unknown;
    };
    expect(firstBody.tools).toBeDefined();
    expect(secondBody.tools).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: 'no tools' });
  });

  it('maps tool results to role tool messages', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        model: OLLAMA_DEFAULT_MODEL,
        message: { role: 'assistant', content: 'done' },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });

    await provider.complete({
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result data' }],
        },
      ],
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]).toEqual({ role: 'tool', content: 'result data' });
  });
});

describe('OllamaProvider.stream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses NDJSON stream lines into StreamChunks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      ndjsonResponse([
        { model: OLLAMA_DEFAULT_MODEL, message: { role: 'assistant', content: 'Hel' }, done: false },
        { model: OLLAMA_DEFAULT_MODEL, message: { role: 'assistant', content: 'Hello' }, done: false },
        {
          model: OLLAMA_DEFAULT_MODEL,
          message: { role: 'assistant', content: 'Hello' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 3,
          eval_count: 2,
        },
      ]),
    );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });

    const chunks = [];
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: 'text_delta', data: { text: 'Hel' } });
    expect(chunks).toContainEqual({ type: 'text_delta', data: { text: 'lo' } });
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      data: {
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string) as {
      stream: boolean;
    };
    expect(body.stream).toBe(true);
  });
});

describe('OllamaProvider.countTokens', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns prompt_eval_count from the chat response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        model: OLLAMA_DEFAULT_MODEL,
        message: { role: 'assistant', content: '.' },
        done: true,
        prompt_eval_count: 88,
        eval_count: 1,
      }),
    );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });
    const count = await provider.countTokens([{ role: 'user', content: 'Hello' }]);
    expect(count).toBe(88);
  });

  it('throws when prompt_eval_count is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        model: OLLAMA_DEFAULT_MODEL,
        message: { role: 'assistant', content: '.' },
        done: true,
      }),
    );

    const provider = createOllamaProvider({ requestsPerMinute: 10_000, maxRetries: 0 });
    await expect(provider.countTokens([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

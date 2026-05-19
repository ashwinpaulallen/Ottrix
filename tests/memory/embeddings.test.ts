import { describe, expect, it } from 'vitest';
import {
  FetchEmbeddingProvider,
  NoOpEmbeddingProvider,
} from '../../src/memory/embeddings.js';

describe('NoOpEmbeddingProvider', () => {
  it('returns zero vectors of configured dimension', async () => {
    const provider = new NoOpEmbeddingProvider({ dimensions: 4 });
    const vector = await provider.embed('hello');
    expect(vector).toEqual([0, 0, 0, 0]);
  });

  it('embedBatch returns one vector per input', async () => {
    const provider = new NoOpEmbeddingProvider({ dimensions: 2 });
    const vectors = await provider.embedBatch(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0, 0]);
  });
});

describe('FetchEmbeddingProvider', () => {
  it('calls an OpenAI-compatible embeddings endpoint', async () => {
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://api.example.com/v1/embeddings');
      expect(init?.method).toBe('POST');
      const rawBody = init?.body;
      const body = JSON.parse(
        typeof rawBody === 'string' ? rawBody : '{}',
      ) as { input: string[]; model: string };
      expect(body.model).toBe('text-embedding-3-small');
      expect(body.input).toEqual(['hello']);

      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const provider = new FetchEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      fetchImpl,
    });

    const vector = await provider.embed('hello');
    expect(vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws on API errors', async () => {
    const provider = new FetchEmbeddingProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    });

    await expect(provider.embed('x')).rejects.toThrow(/bad key/);
  });
});

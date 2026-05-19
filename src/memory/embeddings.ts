/**
 * Pluggable text embedding backend for vector memory.
 */
export interface EmbeddingProvider {
  /** Embed a single text string. */
  embed(text: string): Promise<number[]>;
  /** Embed multiple texts in one request when supported. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** OpenAI-compatible `/v1/embeddings` response shape. */
interface EmbeddingsApiResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

/** Options for {@link FetchEmbeddingProvider}. */
export interface FetchEmbeddingProviderOptions {
  /** API key (Bearer token). */
  apiKey?: string;
  /**
   * API base URL including `/v1` when applicable.
   * @defaultValue `https://api.openai.com/v1`
   */
  baseUrl?: string;
  /** Embedding model identifier. @defaultValue `text-embedding-3-small` */
  model?: string;
  /** Optional embedding dimensions (model-dependent). */
  dimensions?: number;
  /** Custom fetch implementation (for tests or proxies). */
  fetchImpl?: typeof fetch;
  /** Extra headers merged into the request. */
  headers?: Record<string, string>;
}

/**
 * Calls an OpenAI-compatible `POST /embeddings` endpoint via `fetch`.
 */
export class FetchEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  /**
   * @param options - API URL, credentials, and model.
   */
  constructor(options: FetchEmbeddingProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimensions = options.dimensions;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  /** @inheritdoc */
  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    if (!embedding) {
      throw new Error('FetchEmbeddingProvider: empty embedding response');
    }
    return embedding;
  }

  /** @inheritdoc */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };
    if (this.dimensions !== undefined) {
      body.dimensions = this.dimensions;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const rawBody = await response.text();
    let payload: EmbeddingsApiResponse;
    try {
      payload = JSON.parse(rawBody) as EmbeddingsApiResponse;
    } catch {
      throw new Error(
        `FetchEmbeddingProvider: invalid JSON response (status ${response.status})`,
      );
    }

    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `Embeddings request failed with status ${response.status}`,
      );
    }

    if (!payload.data || payload.data.length === 0) {
      throw new Error('FetchEmbeddingProvider: response missing data array');
    }

    if (payload.data.length !== texts.length) {
      throw new Error(
        `FetchEmbeddingProvider: expected ${texts.length} embeddings, received ${payload.data.length}`,
      );
    }

    const sorted = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item, index) => {
      if (!item.embedding || item.embedding.length === 0) {
        throw new Error(`FetchEmbeddingProvider: missing embedding at index ${index}`);
      }
      return item.embedding;
    });
  }
}

/** Options for {@link NoOpEmbeddingProvider}. */
export interface NoOpEmbeddingProviderOptions {
  /** Vector dimensionality. @defaultValue 8 */
  dimensions?: number;
}

/**
 * Returns zero vectors — useful for tests or when similarity search is not required.
 */
export class NoOpEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;

  /**
   * @param options - Zero-vector dimensions.
   */
  constructor(options: NoOpEmbeddingProviderOptions = {}) {
    this.dimensions = options.dimensions ?? 8;
  }

  /** @inheritdoc */
  embed(text: string): Promise<number[]> {
    void text;
    return Promise.resolve(this.zeroVector());
  }

  /** @inheritdoc */
  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => this.zeroVector()));
  }

  private zeroVector(): number[] {
    return Array.from({ length: this.dimensions }, () => 0);
  }
}

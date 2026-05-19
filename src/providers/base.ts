import type { ChatMessage } from '../types/messages.js';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  ProviderConfig,
  StreamChunk,
} from '../types/provider.js';
import { ProviderError, type ProviderErrorCode } from './errors.js';

/** Default maximum retry attempts when not set in config. */
const DEFAULT_MAX_RETRIES = 3;

/** Default initial exponential backoff delay in milliseconds. */
const DEFAULT_INITIAL_DELAY_MS = 500;

/** Default cap on exponential backoff delay in milliseconds. */
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default token-bucket capacity (requests per minute). */
const DEFAULT_REQUESTS_PER_MINUTE = 60;

/**
 * Extended provider configuration used by {@link BaseProvider}.
 */
export interface BaseProviderConfig extends ProviderConfig {
  /** Initial delay before the first retry (ms). @defaultValue 500 */
  retryInitialDelayMs?: number;
  /** Maximum delay between retries (ms). @defaultValue 30000 */
  retryMaxDelayMs?: number;
  /** Maximum outbound requests per minute (token bucket). @defaultValue 60 */
  requestsPerMinute?: number;
  /**
   * Invoked immediately before an HTTP request is sent via {@link BaseProvider.makeRequest}.
   */
  onRequest?: (event: ProviderRequestEvent) => void;
  /**
   * Invoked after an HTTP response is received (including non-2xx statuses).
   */
  onResponse?: (event: ProviderResponseEvent) => void;
}

/**
 * Logging payload for outbound HTTP requests.
 */
export interface ProviderRequestEvent {
  /** Request URL. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Request headers passed to `fetch`. */
  headers?: RequestInit['headers'];
  /** Serialized request body, if any. */
  body?: RequestInit['body'];
}

/**
 * Logging payload for inbound HTTP responses.
 */
export interface ProviderResponseEvent {
  /** Request URL. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** Response headers as a plain key-value map. */
  headers: Record<string, string>;
  /** Raw response body text. */
  body: string;
}

/**
 * Simple token-bucket rate limiter keyed to wall-clock refill.
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  /**
   * @param capacity - Maximum tokens (burst size), typically requests per minute.
   * @param refillPerMs - Tokens added per elapsed millisecond.
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  /**
   * Wait until a token is available, then consume one.
   */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil(deficit / this.refillPerMs));
      await sleep(waitMs);
    }
  }

  /** Add tokens proportional to elapsed time since the last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = now;
  }
}

/**
 * Abstract completion provider with retries, rate limiting, HTTP helpers, and error normalization.
 *
 * Concrete vendors extend this class and implement {@link BaseProvider._rawComplete},
 * {@link BaseProvider._rawStream}, and {@link BaseProvider._countTokens}.
 *
 * @typeParam TModel - Supported model identifier union for this provider.
 */
export abstract class BaseProvider<TModel extends string = string>
  implements CompletionProvider<TModel>
{
  /** Resolved provider configuration (immutable). */
  protected readonly config: BaseProviderConfig;

  private readonly rateLimiter: TokenBucket;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  /**
   * @param config - Connection, retry, rate-limit, and logging settings.
   */
  constructor(config: BaseProviderConfig) {
    this.config = config;
    const rpm = config.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
    this.rateLimiter = new TokenBucket(rpm, rpm / 60_000);
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialDelayMs = config.retryInitialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = config.retryMaxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /**
   * Generate a completion with rate limiting and exponential-backoff retries.
   */
  async complete(params: CompletionParams<TModel>): Promise<CompletionResult<TModel>> {
    return this.withRetry(() => this.executeComplete(params));
  }

  /**
   * Stream completion chunks; retries only on connection-level failures before the first chunk.
   */
  stream(params: CompletionParams<TModel>): AsyncIterable<StreamChunk> {
    return this.createStreamIterable(params);
  }

  /**
   * Estimate token usage for a message list (rate-limited, not retried).
   */
  async countTokens(messages: ChatMessage[]): Promise<number> {
    await this.rateLimiter.acquire();
    try {
      return await this._countTokens(messages);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /**
   * Vendor-specific non-streaming completion. Called by {@link BaseProvider.complete}.
   */
  protected abstract _rawComplete(
    params: CompletionParams<TModel>,
  ): Promise<CompletionResult<TModel>>;

  /**
   * Vendor-specific streaming completion. Called by {@link BaseProvider.stream}.
   */
  protected abstract _rawStream(params: CompletionParams<TModel>): AsyncIterable<StreamChunk>;

  /**
   * Vendor-specific token counting. Called by {@link BaseProvider.countTokens}.
   */
  protected abstract _countTokens(messages: ChatMessage[]): Promise<number>;

  /**
   * Perform an HTTP request with timeout, JSON parsing, hooks, and error normalization.
   *
   * @typeParam T - Expected JSON response shape.
   * @param url - Absolute request URL.
   * @param options - Standard `fetch` init; `signal` is merged with a timeout controller.
   * @returns Parsed JSON body, or `undefined` when the body is empty.
   */
  protected async makeRequest<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const method = options.method ?? 'GET';
    const headers = options.headers;
    const body = options.body ?? null;

    const signals = mergeAbortSignals(options.signal, controller.signal);

    this.config.onRequest?.({ url, method, headers, body });

    try {
      const response = await fetch(url, { ...options, method, headers, body, signal: signals });
      const responseBody = await response.text();

      this.config.onResponse?.({
        url,
        status: response.status,
        headers: headersToRecord(response.headers),
        body: responseBody,
      });

      if (!response.ok) {
        throw this.errorFromHttpResponse(response.status, responseBody);
      }

      if (responseBody.length === 0) {
        return undefined as T;
      }

      try {
        return JSON.parse(responseBody) as T;
      } catch (parseError) {
        throw new ProviderError('Failed to parse JSON response', {
          code: 'server_error',
          retryable: false,
          originalError: parseError,
        });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (isAbortError(error)) {
        throw new ProviderError(`Request timed out after ${timeoutMs}ms`, {
          code: 'timeout',
          retryable: true,
          originalError: error,
        });
      }
      throw this.normalizeError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Map an arbitrary thrown value to a {@link ProviderError}.
   *
   * Subclasses may override to interpret vendor-specific error payloads.
   *
   * @param error - Caught exception or rejection reason.
   */
  protected normalizeError(error: unknown): ProviderError {
    if (ProviderError.isProviderError(error)) {
      return error;
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes('fetch failed') || message.includes('network')) {
        return new ProviderError(error.message, {
          code: 'server_error',
          retryable: true,
          originalError: error,
        });
      }
    }

    return new ProviderError('Unknown provider error', {
      code: 'unknown',
      retryable: false,
      originalError: error,
    });
  }

  /**
   * Build a {@link ProviderError} from an HTTP status code and optional response body.
   *
   * @param status - HTTP status code.
   * @param body - Raw response text for message extraction.
   */
  protected errorFromHttpResponse(status: number, body: string): ProviderError {
    const message = extractErrorMessage(body) ?? `HTTP ${status}`;
    const code = httpStatusToErrorCode(status);
    return new ProviderError(message, {
      code,
      retryable: isRetryableHttpStatus(status),
      originalError: { status, body },
    });
  }

  /** Whether a normalized error represents a connection-level (pre-stream) failure. */
  protected isConnectionError(error: ProviderError): boolean {
    return error.code === 'timeout' || error.code === 'server_error';
  }

  /** Resolve model from params or provider default. */
  protected resolveModel(params: CompletionParams<TModel>): TModel {
    return (params.model ?? this.config.defaultModel) as TModel;
  }

  /**
   * Perform a streaming HTTP request with timeout and logging hooks.
   *
   * Does not buffer the response body on success — `onResponse` receives a placeholder
   * so consumers can parse the stream incrementally.
   */
  protected async fetchStreamResponse(url: string, init: RequestInit = {}): Promise<Response> {
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const method = init.method ?? 'POST';
    const headers = init.headers;
    const body = init.body ?? null;
    const signals = mergeAbortSignals(init.signal, controller.signal);

    this.config.onRequest?.({ url, method, headers, body });

    try {
      const response = await fetch(url, { ...init, method, headers, body, signal: signals });

      if (!response.ok) {
        const errorBody = await response.text();
        this.config.onResponse?.({
          url,
          status: response.status,
          headers: headersToRecord(response.headers),
          body: errorBody,
        });
        throw this.errorFromHttpResponse(response.status, errorBody);
      }

      this.config.onResponse?.({
        url,
        status: response.status,
        headers: headersToRecord(response.headers),
        body: '[streaming response]',
      });

      return response;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (isAbortError(error)) {
        throw new ProviderError(`Request timed out after ${timeoutMs}ms`, {
          code: 'timeout',
          retryable: true,
          originalError: error,
        });
      }
      throw this.normalizeError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Async generator implementing stream retries (connection errors only, before first chunk).
   */
  private async *createStreamIterable(
    params: CompletionParams<TModel>,
  ): AsyncGenerator<StreamChunk> {
    let attempt = 0;
    for (;;) {
      let receivedChunk = false;
      try {
        await this.rateLimiter.acquire();
        const chunks = this._rawStream(params);
        for await (const chunk of chunks) {
          receivedChunk = true;
          yield chunk;
        }
        return;
      } catch (error) {
        const normalized = this.normalizeError(error);
        if (
          receivedChunk ||
          !normalized.retryable ||
          !this.isConnectionError(normalized) ||
          attempt >= this.maxRetries
        ) {
          throw normalized;
        }
        await this.delay(this.backoffMs(attempt));
        attempt += 1;
      }
    }
  }

  /** Execute `_rawComplete` behind rate limiting without retries. */
  private async executeComplete(
    params: CompletionParams<TModel>,
  ): Promise<CompletionResult<TModel>> {
    await this.rateLimiter.acquire();
    try {
      return await this._rawComplete(params);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /** Retry a retryable async operation with exponential backoff. */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const normalized = this.normalizeError(error);
        if (!normalized.retryable || attempt >= this.maxRetries) {
          throw normalized;
        }
        await this.delay(this.backoffMs(attempt));
        attempt += 1;
      }
    }
  }

  /** Compute backoff delay for a zero-based attempt index. */
  private backoffMs(attempt: number): number {
    const delay = this.initialDelayMs * 2 ** attempt;
    return Math.min(delay, this.maxDelayMs);
  }

  /** Promise-based sleep helper. */
  private delay(ms: number): Promise<void> {
    return sleep(ms);
  }
}

/** Sleep for the given duration. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Combine optional external and timeout abort signals. */
function mergeAbortSignals(
  external: AbortSignal | null | undefined,
  timeout: AbortSignal,
): AbortSignal {
  if (!external) return timeout;
  if (external.aborted) return external;
  if (timeout.aborted) return timeout;

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();

  external.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });

  if (external.aborted || timeout.aborted) {
    controller.abort();
  }

  return controller.signal;
}

/** Whether an error is an abort (timeout) from `fetch`. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Map HTTP status codes to {@link ProviderErrorCode}. */
function httpStatusToErrorCode(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status === 413 || status === 422) return 'context_length';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

/** Whether an HTTP status should be retried. */
function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Flatten `Headers` into a plain object for logging hooks. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** Best-effort message extraction from JSON or plain-text error bodies. */
function extractErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed.error?.message ?? parsed.message;
  } catch {
    return body.length <= 500 ? body : undefined;
  }
}

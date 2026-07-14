import type { ChatMessage, ContentBlock } from './messages.js';
import type { ToolDefinition } from './tools.js';

/**
 * Token consumption reported by a provider for a single completion.
 */
export interface TokenUsage {
  /** Tokens consumed by the prompt (input). */
  inputTokens: number;
  /** Tokens generated in the completion (output). */
  outputTokens: number;
  /** Sum of input and output tokens. */
  totalTokens: number;
  /** Anthropic prompt-cache read tokens (`cache_read_input_tokens`), when reported. */
  cacheReadTokens?: number;
  /** Anthropic prompt-cache write tokens (`cache_creation_input_tokens`), when reported. */
  cacheWriteTokens?: number;
}

/** Circuit breaker settings for a provider instance. */
export interface CircuitBreakerConfig {
  /** Consecutive failures before opening the circuit. @defaultValue 5 */
  failureThreshold?: number;
  /** Ms before OPEN transitions to HALF_OPEN. @defaultValue 60000 */
  resetTimeoutMs?: number;
  /** Successful half-open probes required to close. @defaultValue 1 */
  halfOpenMaxAttempts?: number;
}

/**
 * Connection and retry settings for a model provider.
 */
export interface ProviderConfig {
  /** API key or bearer token (if applicable). */
  apiKey?: string;
  /** Override base URL for self-hosted or proxy endpoints. */
  baseUrl?: string;
  /** Default model identifier when none is passed per request. */
  defaultModel: string;
  /** Maximum retry attempts for transient failures. */
  maxRetries?: number;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** Optional circuit breaker overrides (enabled by default on {@link BaseProvider}). */
  circuitBreaker?: CircuitBreakerConfig;
  /** Disable the circuit breaker for this provider. */
  circuitBreakerDisabled?: boolean;
}

/**
 * Parameters for a non-streaming or streaming completion request.
 */
export interface CompletionParams<TModel extends string = string> {
  /** Conversation history including tool turns. */
  messages: ChatMessage[];
  /** Model override; falls back to provider default. */
  model?: TModel;
  /** Sampling temperature (provider-specific semantics). */
  temperature?: number;
  /** Maximum tokens to generate in the response. */
  maxTokens?: number;
  /** Tool definitions available to the model. */
  tools?: ToolDefinition[];
  /** Sequences that halt generation when emitted. */
  stopSequences?: string[];
  /** System prompt prepended or injected by the provider adapter. */
  systemPrompt?: string;
  /**
   * Hint for providers that support native JSON response modes (e.g. OpenAI `json_object`).
   * @defaultValue `"text"`
   */
  responseFormat?: 'json' | 'text';
}

/** Latency metrics for a single provider request. */
export interface CompletionLatency {
  /** Time to first token in milliseconds (equals {@link totalTime} for non-streaming). */
  ttft: number;
  /** Total request time in milliseconds. */
  totalTime: number;
  /** Output tokens per second (`outputTokens / (totalTime / 1000)`). */
  tokensPerSecond: number;
}

/** Optional metadata attached to completion results. */
export interface CompletionResultMetadata {
  /** Registry or logical provider name that served the request. */
  provider?: string;
  /** One-based attempt index on the serving provider (includes retries). */
  attempt?: number;
  /** Number of prior providers tried before success (0 when the first provider succeeded). */
  fallbacksTriggered?: number;
  /** Wall-clock time for the full chain including retries, backoff, and fallbacks (ms). */
  totalLatencyMs?: number;
}

/**
 * Final result of a completed (non-streaming) model call.
 */
export interface CompletionResult<TModel extends string = string> {
  /** Structured assistant output blocks. */
  content: ContentBlock[];
  /** Resolved model identifier. */
  model: TModel;
  /** Token accounting for this completion. */
  usage: TokenUsage;
  /** Provider-specific stop reason (e.g. `end_turn`, `max_tokens`, `tool_use`). */
  stopReason: string;
  /** Request latency breakdown. */
  latency: CompletionLatency;
  /** Routing and observability metadata (e.g. which provider served the request). */
  metadata?: CompletionResultMetadata;
}

/** Common optional fields on streaming chunks. */
export interface StreamChunkTiming {
  /** High-resolution timestamp (`performance.now()`) when the chunk was produced. */
  timestamp?: number;
}

/** Incremental text emitted during streaming. */
export interface StreamTextDeltaChunk extends StreamChunkTiming {
  type: 'text_delta';
  data: { text: string };
}

/** Signals the start of a tool-use block in the stream. */
export interface StreamToolUseStartChunk extends StreamChunkTiming {
  type: 'tool_use_start';
  data: { id: string; name: string };
}

/** Partial JSON or arguments for an in-flight tool call. */
export interface StreamToolUseDeltaChunk extends StreamChunkTiming {
  type: 'tool_use_delta';
  data: { id: string; partialInput: string };
}

/** Signals a completed tool-use block in the stream. */
export interface StreamToolUseEndChunk extends StreamChunkTiming {
  type: 'tool_use_end';
  data: { id: string; name: string; input: Record<string, unknown> };
}

/** Terminal chunk indicating the stream has finished. */
export interface StreamDoneChunk extends StreamChunkTiming {
  type: 'done';
  data: {
    stopReason: string;
    usage?: TokenUsage;
    latency?: CompletionLatency;
  };
}

/**
 * Discriminated union of streaming events from a {@link CompletionProvider}.
 */
export type StreamChunk =
  | StreamTextDeltaChunk
  | StreamToolUseStartChunk
  | StreamToolUseDeltaChunk
  | StreamToolUseEndChunk
  | StreamDoneChunk;

/**
 * Abstraction over an LLM or completion backend.
 *
 * @typeParam TModel - Union of model identifiers supported by this provider.
 */
export interface CompletionProvider<TModel extends string = string> {
  /**
   * Generate a full completion in one round-trip.
   */
  complete(params: CompletionParams<TModel>): Promise<CompletionResult<TModel>>;

  /**
   * Stream completion events as they are produced.
   */
  stream(params: CompletionParams<TModel>): AsyncIterable<StreamChunk>;

  /**
   * Estimate token count for a message list (used for budgeting).
   */
  countTokens(messages: ChatMessage[]): Promise<number>;
}

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
}

/** Incremental text emitted during streaming. */
export interface StreamTextDeltaChunk {
  type: 'text_delta';
  data: { text: string };
}

/** Signals the start of a tool-use block in the stream. */
export interface StreamToolUseStartChunk {
  type: 'tool_use_start';
  data: { id: string; name: string };
}

/** Partial JSON or arguments for an in-flight tool call. */
export interface StreamToolUseDeltaChunk {
  type: 'tool_use_delta';
  data: { id: string; partialInput: string };
}

/** Signals a completed tool-use block in the stream. */
export interface StreamToolUseEndChunk {
  type: 'tool_use_end';
  data: { id: string; name: string; input: Record<string, unknown> };
}

/** Terminal chunk indicating the stream has finished. */
export interface StreamDoneChunk {
  type: 'done';
  data: {
    stopReason: string;
    usage?: TokenUsage;
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

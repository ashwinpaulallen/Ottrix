import type { ChatMessage, ContentBlock, ImageBlock, TextBlock } from '../types/messages.js';
import type {
  CompletionParams,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from '../types/provider.js';
import type { JSONSchema, ToolDefinition } from '../types/tools.js';
import { BaseProvider, type BaseProviderConfig } from './base.js';
import { ProviderError } from './errors.js';

/** Default OpenAI API base URL (v1). */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Default OpenAI chat model. */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o';

/** Well-known OpenAI model identifiers. */
export type OpenAIModel = typeof OPENAI_DEFAULT_MODEL | (string & {});

/**
 * Configuration for {@link OpenAIProvider}.
 */
export interface OpenAIProviderConfig extends BaseProviderConfig {
  /** OpenAI (or compatible) API key. */
  apiKey: string;
  /**
   * API base URL without trailing slash.
   * Supports OpenAI-compatible hosts (Groq, Together, vLLM, etc.).
   * @defaultValue `https://api.openai.com/v1`
   */
  baseUrl?: string;
  /** Optional organization header (`OpenAI-Organization`). */
  organization?: string;
}

/**
 * Input for {@link createOpenAIProvider}.
 */
export type CreateOpenAIProviderConfig = Omit<OpenAIProviderConfig, 'defaultModel' | 'baseUrl'> & {
  /** API key for Bearer authentication. */
  apiKey: string;
  /** Model override; defaults to {@link OPENAI_DEFAULT_MODEL}. */
  model?: OpenAIModel;
  /** OpenAI-compatible API base URL. */
  baseUrl?: string;
};

/** OpenAI chat message parameter. */
type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: OpenAIUserContent }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type OpenAIUserContent = string | OpenAIContentPart[];

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** OpenAI tool / function definition. */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** Tool call on an assistant message. */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Chat Completions API response. */
interface OpenAIChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Streaming chunk from the Chat Completions API. */
interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Concrete {@link BaseProvider} for the OpenAI Chat Completions API (fetch-only, no SDK).
 *
 * Works with OpenAI-compatible endpoints when `baseUrl` is configured.
 */
export class OpenAIProvider extends BaseProvider<OpenAIModel> {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly organization?: string;

  /**
   * @param config - Provider configuration including a required `apiKey`.
   */
  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAIProvider requires an apiKey');
    }
    super({
      ...config,
      defaultModel: config.defaultModel ?? OPENAI_DEFAULT_MODEL,
      baseUrl: config.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
    });
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.organization = config.organization;
  }

  /** Resolved chat completions URL for the configured {@link baseUrl}. */
  get chatCompletionsUrl(): string {
    if (this.baseUrl.endsWith('/chat/completions')) {
      return this.baseUrl;
    }
    return `${this.baseUrl}/chat/completions`;
  }

  /** @inheritdoc */
  protected async _rawComplete(
    params: CompletionParams<OpenAIModel>,
  ): Promise<CompletionResult<OpenAIModel>> {
    const body = this.buildRequestBody(params, false);
    const response = await this.makeRequest<OpenAIChatCompletionResponse>(this.chatCompletionsUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    return this.mapCompletionResponse(response, this.resolveModel(params));
  }

  /** @inheritdoc */
  protected async *_rawStream(
    params: CompletionParams<OpenAIModel>,
  ): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(params, true);
    const response = await this.postStream(this.chatCompletionsUrl, body);

    if (!response.body) {
      throw new ProviderError('OpenAI stream response has no body', {
        code: 'server_error',
        retryable: true,
        originalError: response,
      });
    }

    yield* this.parseOpenAIStream(response.body);
  }

  /**
   * Count input tokens via a minimal completion request (`usage.prompt_tokens`).
   *
   * Note: This performs a low-`max_tokens` API call; compatible hosts must return `usage`.
   */
  protected async _countTokens(messages: ChatMessage[]): Promise<number> {
    const body = {
      model: this.config.defaultModel,
      messages: mapMessages(messages),
      max_tokens: 1,
      temperature: 0,
    };

    const response = await this.makeRequest<OpenAIChatCompletionResponse>(this.chatCompletionsUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.usage) {
      throw new ProviderError('OpenAI response missing usage field for token counting', {
        code: 'server_error',
        retryable: false,
        originalError: response,
      });
    }

    return response.usage.prompt_tokens;
  }

  /** @inheritdoc */
  protected override errorFromHttpResponse(status: number, body: string): ProviderError {
    if (status === 401) {
      return new ProviderError(extractOpenAIErrorMessage(body) ?? 'Invalid OpenAI API key', {
        code: 'auth',
        retryable: false,
        originalError: { status, body },
      });
    }
    if (status === 429) {
      return new ProviderError(extractOpenAIErrorMessage(body) ?? 'OpenAI rate limit exceeded', {
        code: 'rate_limit',
        retryable: true,
        originalError: { status, body },
      });
    }
    if (status === 413) {
      return new ProviderError(extractOpenAIErrorMessage(body) ?? 'Context length exceeded', {
        code: 'context_length',
        retryable: false,
        originalError: { status, body },
      });
    }
    return super.errorFromHttpResponse(status, body);
  }

  /** Build authorization and content headers. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }
    return headers;
  }

  /** Build the Chat Completions request body. */
  private buildRequestBody(
    params: CompletionParams<OpenAIModel>,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = mapMessages(params.messages, params.systemPrompt);
    const body: Record<string, unknown> = {
      model: this.resolveModel(params),
      messages,
      stream,
    };

    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
    if (params.stopSequences?.length) body.stop = params.stopSequences;
    if (params.tools?.length) body.tools = mapTools(params.tools);

    return body;
  }

  /** POST a streaming request and return the raw `Response`. */
  private async postStream(
    url: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.fetchStreamResponse(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
  }

  /** Map OpenAI chat completion response to {@link CompletionResult}. */
  private mapCompletionResponse(
    response: OpenAIChatCompletionResponse,
    model: OpenAIModel,
  ): CompletionResult<OpenAIModel> {
    const choice = response.choices[0];
    if (!choice) {
      throw new ProviderError('OpenAI response contained no choices', {
        code: 'server_error',
        retryable: false,
        originalError: response,
      });
    }

    return {
      content: mapAssistantMessageToContent(choice.message),
      model: response.model ?? model,
      usage: mapUsage(response.usage),
      stopReason: mapFinishReason(choice.finish_reason),
    };
  }

  /** Parse OpenAI SSE (`data: ...` / `data: [DONE]`) into stream chunks. */
  private async *parseOpenAIStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let stopReason = 'stop';
    let usage: TokenUsage | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          if (chunk.usage) {
            usage = mapUsage(chunk.usage);
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            stopReason = mapFinishReason(choice.finish_reason);
            if (choice.finish_reason === 'tool_calls') {
              for (const endChunk of closeOpenToolCalls(toolCalls)) {
                yield endChunk;
              }
            }
          }

          for (const streamChunk of mapStreamDelta(choice.delta, toolCalls)) {
            yield streamChunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'done',
      data: { stopReason, usage },
    };
  }
}

/**
 * Create a configured {@link OpenAIProvider} instance.
 *
 * @param config - API key, optional model/baseUrl, and {@link BaseProviderConfig} options.
 */
export function createOpenAIProvider(config: CreateOpenAIProviderConfig): OpenAIProvider {
  const { apiKey, model, baseUrl, ...rest } = config;
  return new OpenAIProvider({
    ...rest,
    apiKey,
    baseUrl: baseUrl ?? OPENAI_DEFAULT_BASE_URL,
    defaultModel: model ?? OPENAI_DEFAULT_MODEL,
  });
}

/** Map universal messages to OpenAI chat message parameters. */
function mapMessages(messages: ChatMessage[], systemPrompt?: string): OpenAIMessage[] {
  const openaiMessages: OpenAIMessage[] = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        openaiMessages.push({
          role: 'system',
          content: messageContentToString(message.content),
        });
        break;
      case 'user':
        openaiMessages.push({
          role: 'user',
          content: mapUserContent(message.content),
        });
        break;
      case 'assistant':
        openaiMessages.push(mapAssistantMessage(message.content));
        break;
      case 'tool':
        openaiMessages.push(...mapToolMessages(message.content));
        break;
      default:
        break;
    }
  }

  return openaiMessages;
}

/** Map universal tool definitions to OpenAI function tools. */
function mapTools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Map user content (string or blocks) to OpenAI user content. */
function mapUserContent(content: string | ContentBlock[]): OpenAIUserContent {
  if (typeof content === 'string') return content;

  const parts: OpenAIContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: mapImageUrl(block) } });
    }
  }

  return parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts;
}

/** Build a data URL or pass through URL for OpenAI vision input. */
function mapImageUrl(block: ImageBlock): string {
  if (block.source.type === 'url') {
    return block.source.data;
  }
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/** Map assistant universal content to OpenAI assistant message. */
function mapAssistantMessage(content: string | ContentBlock[]): OpenAIMessage {
  if (typeof content === 'string') {
    return { role: 'assistant', content };
  }

  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const message: OpenAIMessage = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('\n') : null,
  };

  if (toolCalls.length > 0 && message.role === 'assistant') {
    message.tool_calls = toolCalls;
  }

  return message;
}

/** Map tool-role content to one or more OpenAI `tool` messages. */
function mapToolMessages(content: string | ContentBlock[]): OpenAIMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'tool', tool_call_id: 'unknown', content }];
  }

  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    .map((block) => ({
      role: 'tool' as const,
      tool_call_id: block.tool_use_id,
      content: toolResultToString(block.content),
    }));
}

/** Map OpenAI assistant message to universal content blocks. */
function mapAssistantMessageToContent(message: {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    const input = parseToolArguments(call.function.arguments);
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input,
    });
  }

  return blocks;
}

/** OpenAI streaming delta payload. */
interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

/** Map streaming delta to universal chunks. */
function* mapStreamDelta(
  delta: OpenAIStreamDelta | undefined,
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
): Generator<StreamChunk> {
  if (!delta) return;

  if (delta.content) {
    yield { type: 'text_delta', data: { text: delta.content } };
  }

  for (const partial of delta.tool_calls ?? []) {
    const index = partial.index;
    let tracked = toolCalls.get(index);

    if (!tracked && partial.id && partial.function?.name) {
      tracked = {
        id: partial.id,
        name: partial.function.name,
        arguments: partial.function.arguments ?? '',
      };
      toolCalls.set(index, tracked);
      yield {
        type: 'tool_use_start',
        data: { id: tracked.id, name: tracked.name },
      };
    } else if (tracked) {
      if (partial.id) tracked.id = partial.id;
      if (partial.function?.name) tracked.name = partial.function.name;
      if (partial.function?.arguments) {
        tracked.arguments += partial.function.arguments;
        yield {
          type: 'tool_use_delta',
          data: { id: tracked.id, partialInput: partial.function.arguments },
        };
      }
    }
  }
}

/** Emit tool_use_end chunks for any tracked tool calls still open at stream end. */
function closeOpenToolCalls(
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const tool of toolCalls.values()) {
    const input = parseToolArguments(tool.arguments);
    chunks.push({
      type: 'tool_use_end',
      data: { id: tool.id, name: tool.name, input },
    });
  }
  toolCalls.clear();
  return chunks;
}

/** Parse tool argument JSON safely. */
function parseToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson) return {};
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Map OpenAI `finish_reason` to universal `stopReason`. */
function mapFinishReason(finishReason: string | null | undefined): string {
  if (!finishReason) return 'stop';
  return finishReason;
}

/** Map OpenAI usage to {@link TokenUsage}. */
function mapUsage(usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}): TokenUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

/** Coerce tool result content to a string for OpenAI `tool` messages. */
function toolResultToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Coerce message content to plain text. */
function messageContentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Extract error message from OpenAI JSON error payloads. */
function extractOpenAIErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message;
  } catch {
    return undefined;
  }
}

import type { ChatMessage, ContentBlock, ImageBlock, TextBlock } from '../types/messages.js';
import type {
  CompletionParams,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from '../types/provider.js';
import { stampStreamChunk, unknownCompletionLatency } from './latency.js';
import type { JSONSchema, ToolDefinition } from '../types/tools.js';
import { BaseProvider, type BaseProviderConfig } from './base.js';
import { ProviderError } from './errors.js';

/** Default Ollama server URL. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/** Default Ollama model. */
export const OLLAMA_DEFAULT_MODEL = 'llama3.1';

/** Well-known Ollama model identifiers. */
export type OllamaModel = typeof OLLAMA_DEFAULT_MODEL | (string & {});

/**
 * Summary of a model returned by {@link OllamaProvider.listModels}.
 */
export interface OllamaModelInfo {
  /** Model name (e.g. `llama3.1:latest`). */
  name: string;
  /** Model identifier (often same as `name`). */
  model: string;
  /** ISO timestamp when the model was last modified, if available. */
  modifiedAt?: string;
  /** Approximate model size in bytes, if available. */
  size?: number;
}

/**
 * Result of {@link OllamaProvider.healthCheck}.
 */
export interface OllamaHealthStatus {
  /** Whether the Ollama server responded successfully. */
  ok: boolean;
  /** Server version string when available. */
  version?: string;
}

/**
 * Configuration for {@link OllamaProvider}.
 */
export interface OllamaProviderConfig extends Omit<BaseProviderConfig, 'defaultModel'> {
  /** Model name served by Ollama; defaults to {@link OLLAMA_DEFAULT_MODEL}. */
  defaultModel?: string;
  /**
   * Ollama server base URL without trailing slash.
   * @defaultValue `http://localhost:11434`
   */
  baseUrl?: string;
  /**
   * When true, tool definitions are sent to the API.
   * If the model rejects tools, the request is retried without them.
   * @defaultValue `true`
   */
  enableTools?: boolean;
}

/**
 * Input for {@link createOllamaProvider}.
 */
export type CreateOllamaProviderConfig = Omit<OllamaProviderConfig, 'defaultModel' | 'baseUrl'> & {
  /** Model override; defaults to {@link OLLAMA_DEFAULT_MODEL}. */
  model?: OllamaModel;
  /** Ollama server base URL. */
  baseUrl?: string;
};

/** Ollama chat message. */
type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
};

/** Tool call emitted by Ollama. */
interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

/** Ollama tool definition. */
interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** Non-streaming or final chat response line. */
interface OllamaChatResponse {
  model: string;
  created_at?: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** `/api/tags` response shape. */
interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    modified_at?: string;
    size?: number;
  }>;
}

/**
 * Concrete {@link BaseProvider} for local [Ollama](https://ollama.com) inference.
 */
export class OllamaProvider extends BaseProvider<OllamaModel> {
  private readonly baseUrl: string;
  private readonly enableTools: boolean;

  /**
   * @param config - Ollama connection settings.
   */
  constructor(config: OllamaProviderConfig = {}) {
    super({
      ...config,
      defaultModel: config.defaultModel ?? OLLAMA_DEFAULT_MODEL,
      baseUrl: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      maxRetries: config.maxRetries ?? 2,
    });
    this.baseUrl = (config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.enableTools = config.enableTools ?? true;
  }

  /** Resolved `/api/chat` URL. */
  get chatUrl(): string {
    return `${this.baseUrl}/api/chat`;
  }

  /** Resolved `/api/tags` URL. */
  get tagsUrl(): string {
    return `${this.baseUrl}/api/tags`;
  }

  /**
   * List models available on an Ollama server.
   *
   * @param baseUrl - Server base URL; defaults to {@link OLLAMA_DEFAULT_BASE_URL}.
   */
  static async listModels(baseUrl: string = OLLAMA_DEFAULT_BASE_URL): Promise<OllamaModelInfo[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new ProviderError(`Failed to list Ollama models: HTTP ${response.status}`, {
        code: 'server_error',
        retryable: response.status >= 500,
        originalError: await response.text(),
      });
    }
    const data = (await response.json()) as OllamaTagsResponse;
    return data.models.map((m) => ({
      name: m.name,
      model: m.model,
      modifiedAt: m.modified_at,
      size: m.size,
    }));
  }

  /**
   * Ping the Ollama server and report availability.
   */
  async healthCheck(): Promise<OllamaHealthStatus> {
    try {
      const response = await fetch(this.baseUrl, { method: 'GET' });
      if (!response.ok) {
        return { ok: false };
      }
      const body = await response.text();
      return {
        ok: true,
        version: body.includes('Ollama') ? body.trim() : undefined,
      };
    } catch {
      return { ok: false };
    }
  }

  /** @inheritdoc */
  protected async _rawComplete(
    params: CompletionParams<OllamaModel>,
  ): Promise<CompletionResult<OllamaModel>> {
    return this.chatWithOptionalToolFallback(params, false);
  }

  /** @inheritdoc */
  protected async *_rawStream(
    params: CompletionParams<OllamaModel>,
  ): AsyncGenerator<StreamChunk> {
    yield* this.streamWithOptionalToolFallback(params);
  }

  /** @inheritdoc */
  protected async _countTokens(messages: ChatMessage[]): Promise<number> {
    const body = {
      model: this.config.defaultModel,
      messages: mapMessages(messages),
      stream: false,
      options: { num_predict: 1 },
    };

    const response = await this.makeRequest<OllamaChatResponse>(this.chatUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (response.prompt_eval_count === undefined) {
      throw new ProviderError('Ollama response missing prompt_eval_count for token counting', {
        code: 'server_error',
        retryable: false,
        originalError: response,
      });
    }

    return response.prompt_eval_count;
  }

  /** @inheritdoc */
  protected override normalizeError(error: unknown): ProviderError {
    if (ProviderError.isProviderError(error)) {
      return error;
    }
    if (error instanceof Error && error.message.toLowerCase().includes('econnrefused')) {
      return new ProviderError(
        `Cannot connect to Ollama at ${this.baseUrl}. Is the server running?`,
        { code: 'server_error', retryable: true, originalError: error },
      );
    }
    return super.normalizeError(error);
  }

  /** Build JSON request headers. */
  private buildHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  /** Execute chat with tool fallback when the model does not support tools. */
  private async chatWithOptionalToolFallback(
    params: CompletionParams<OllamaModel>,
    stream: boolean,
  ): Promise<CompletionResult<OllamaModel>> {
    const includeTools = this.shouldIncludeTools(params);
    try {
      const body = this.buildRequestBody(params, stream, includeTools);
      const response = await this.makeRequest<OllamaChatResponse>(this.chatUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      return this.mapCompletionResponse(response, this.resolveModel(params));
    } catch (error) {
      if (includeTools && params.tools?.length && isToolsUnsupportedError(error)) {
        const body = this.buildRequestBody(params, stream, false);
        const response = await this.makeRequest<OllamaChatResponse>(this.chatUrl, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
        });
        return this.mapCompletionResponse(response, this.resolveModel(params));
      }
      throw this.normalizeError(error);
    }
  }

  /** Stream chat with tool fallback on unsupported models. */
  private async *streamWithOptionalToolFallback(
    params: CompletionParams<OllamaModel>,
  ): AsyncGenerator<StreamChunk> {
    const includeTools = this.shouldIncludeTools(params);
    try {
      yield* this.readChatStream(params, includeTools);
    } catch (error) {
      if (includeTools && params.tools?.length && isToolsUnsupportedError(error)) {
        yield* this.readChatStream(params, false);
        return;
      }
      throw this.normalizeError(error);
    }
  }

  /** Open a streaming `/api/chat` request and yield universal chunks. */
  private async *readChatStream(
    params: CompletionParams<OllamaModel>,
    includeTools: boolean,
  ): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(params, true, includeTools);
    const payload = JSON.stringify(body);

    const response = await this.fetchStreamResponse(this.chatUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: payload,
    });

    if (!response.body) {
      throw new ProviderError('Ollama stream response has no body', {
        code: 'server_error',
        retryable: true,
        originalError: response,
      });
    }

    let previousContent = '';
    let usage: TokenUsage | undefined;
    let stopReason = 'stop';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const readResult = await reader.read();
        if (readResult.done) break;
        const arrivedAt = performance.now();
        if (readResult.value !== undefined) {
          buffer += decoder.decode(readResult.value as Uint8Array, { stream: true });
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const chunk = JSON.parse(trimmed) as OllamaChatResponse;
          if (chunk.error) {
            throw new ProviderError(chunk.error, {
              code: 'server_error',
              retryable: false,
              originalError: chunk,
            });
          }

          if (chunk.message?.content) {
            const full = chunk.message.content;
            const delta = full.startsWith(previousContent)
              ? full.slice(previousContent.length)
              : full;
            if (delta) {
              yield stampStreamChunk({ type: 'text_delta', data: { text: delta } }, arrivedAt);
            }
            previousContent = full;
          }

          if (chunk.message?.tool_calls?.length) {
            const toolCalls = chunk.message.tool_calls;
            for (let i = 0; i < toolCalls.length; i++) {
              const call = toolCalls[i];
              if (!call) continue;
              const id = ollamaToolCallId(call, i);
              const args = normalizeToolArguments(call.function.arguments);
              yield stampStreamChunk({ type: 'tool_use_start', data: { id, name: call.function.name } }, arrivedAt);
              yield stampStreamChunk({ type: 'tool_use_end', data: { id, name: call.function.name, input: args } }, arrivedAt);
            }
          }

          if (chunk.done) {
            stopReason = chunk.done_reason ?? 'stop';
            usage = mapOllamaUsage(chunk);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield stampStreamChunk({
      type: 'done',
      data: { stopReason, usage },
    });
  }

  /** Build `/api/chat` request body. */
  private buildRequestBody(
    params: CompletionParams<OllamaModel>,
    stream: boolean,
    includeTools: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.resolveModel(params),
      messages: mapMessages(params.messages, params.systemPrompt),
      stream,
    };

    const options: Record<string, unknown> = {};
    if (params.temperature !== undefined) options.temperature = params.temperature;
    if (params.maxTokens !== undefined) options.num_predict = params.maxTokens;
    if (params.stopSequences?.length) options.stop = params.stopSequences;
    if (Object.keys(options).length > 0) body.options = options;
    if (includeTools && params.tools?.length) {
      body.tools = mapTools(params.tools);
    }

    return body;
  }

  /** Whether tools should be included for this request. */
  private shouldIncludeTools(params: CompletionParams<OllamaModel>): boolean {
    return this.enableTools && (params.tools?.length ?? 0) > 0;
  }

  /** Map Ollama chat response to {@link CompletionResult}. */
  private mapCompletionResponse(
    response: OllamaChatResponse,
    model: OllamaModel,
  ): CompletionResult<OllamaModel> {
    if (response.error) {
      throw new ProviderError(response.error, {
        code: 'server_error',
        retryable: false,
        originalError: response,
      });
    }

    return {
      content: mapAssistantMessageToContent(response.message),
      model: response.model ?? model,
      usage: mapOllamaUsage(response),
      stopReason: response.done_reason ?? 'stop',
      latency: unknownCompletionLatency(),
    };
  }
}

/**
 * Create a configured {@link OllamaProvider} instance.
 *
 * @param config - Optional model, base URL, and {@link BaseProviderConfig} options.
 */
export function createOllamaProvider(config: CreateOllamaProviderConfig = {}): OllamaProvider {
  const { model, baseUrl, ...rest } = config;
  return new OllamaProvider({
    ...rest,
    baseUrl: baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
    defaultModel: model ?? OLLAMA_DEFAULT_MODEL,
  });
}

/** Map universal messages to Ollama chat messages. */
function mapMessages(messages: ChatMessage[], systemPrompt?: string): OllamaMessage[] {
  const ollamaMessages: OllamaMessage[] = [];

  if (systemPrompt) {
    ollamaMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        ollamaMessages.push({
          role: 'system',
          content: messageContentToString(message.content),
        });
        break;
      case 'user':
        ollamaMessages.push(mapUserMessage(message.content));
        break;
      case 'assistant':
        ollamaMessages.push(mapAssistantMessage(message.content));
        break;
      case 'tool':
        ollamaMessages.push(...mapToolMessages(message.content));
        break;
      default:
        break;
    }
  }

  return ollamaMessages;
}

/** Map user content, extracting base64 images when present. */
function mapUserMessage(content: string | ContentBlock[]): OllamaMessage {
  if (typeof content === 'string') {
    return { role: 'user', content };
  }

  const textParts: string[] = [];
  const images: string[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      images.push(mapImageData(block));
    }
  }

  const msg: OllamaMessage = {
    role: 'user',
    content: textParts.join('\n') || ' ',
  };
  if (images.length > 0) msg.images = images;
  return msg;
}

/** Map image block to raw base64 for Ollama `images` array. */
function mapImageData(block: ImageBlock): string {
  if (block.source.type === 'base64') {
    return block.source.data;
  }
  return block.source.data;
}

/** Map assistant universal content to Ollama assistant message. */
function mapAssistantMessage(content: string | ContentBlock[]): OllamaMessage {
  if (typeof content === 'string') {
    return { role: 'assistant', content };
  }

  const textParts: string[] = [];
  const toolCalls: OllamaToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        function: {
          name: block.name,
          arguments: block.input,
        },
      });
    }
  }

  const message: OllamaMessage = {
    role: 'assistant',
    content: textParts.join('\n'),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

/** Map tool-role messages to Ollama `tool` role messages. */
function mapToolMessages(content: string | ContentBlock[]): OllamaMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'tool', content }];
  }

  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    .map((block) => ({
      role: 'tool' as const,
      content: toolResultToString(block.content),
    }));
}

/** Map tool definitions to Ollama format. */
function mapTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Map Ollama assistant message to universal content blocks. */
function mapAssistantMessageToContent(message: OllamaChatResponse['message']): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }

  const toolCalls = message.tool_calls ?? [];
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call) continue;
    blocks.push({
      type: 'tool_use',
      id: ollamaToolCallId(call, i),
      name: call.function.name,
      input: normalizeToolArguments(call.function.arguments),
    });
  }

  return blocks;
}

/** Stable tool-call id when Ollama does not assign one. */
function ollamaToolCallId(call: OllamaToolCall, index: number): string {
  return `ollama_${call.function.name}_${index}`;
}

/** Map Ollama eval counts to {@link TokenUsage}. */
function mapOllamaUsage(response: OllamaChatResponse): TokenUsage {
  const inputTokens = response.prompt_eval_count ?? 0;
  const outputTokens = response.eval_count ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Normalize tool arguments that may be objects or JSON strings. */
function normalizeToolArguments(
  args: Record<string, unknown> | string,
): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return args;
}

/** Whether an error indicates the model does not support tool calling. */
function isToolsUnsupportedError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof ProviderError) {
    parts.push(error.message);
    const orig = error.originalError;
    if (typeof orig === 'object' && orig !== null && 'body' in orig) {
      parts.push(String((orig as { body: string }).body));
    } else if (typeof orig === 'string') {
      parts.push(orig);
    }
  } else if (error instanceof Error) {
    parts.push(error.message);
  } else {
    parts.push(String(error));
  }
  const lower = parts.join(' ').toLowerCase();
  return (
    lower.includes('does not support tools') ||
    lower.includes('does not support tool') ||
    lower.includes('tool call') ||
    lower.includes('function calling') ||
    lower.includes('tools are not supported') ||
    (lower.includes('unknown field') && lower.includes('tools'))
  );
}

/** Coerce tool result content to string. */
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

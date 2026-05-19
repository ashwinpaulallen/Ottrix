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

/** Anthropic Messages API base URL. */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** Anthropic token counting endpoint. */
export const ANTHROPIC_COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

/** Default Anthropic API version header value. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default Claude model identifier. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** Well-known Anthropic model identifiers. */
export type AnthropicModel = typeof ANTHROPIC_DEFAULT_MODEL | (string & {});

/**
 * Configuration for {@link AnthropicProvider}.
 */
export interface AnthropicProviderConfig extends BaseProviderConfig {
  /** Anthropic API key (required). */
  apiKey: string;
  /** `anthropic-version` header override. @defaultValue `2023-06-01` */
  anthropicVersion?: string;
}

/**
 * Input for {@link createAnthropicProvider}.
 */
export type CreateAnthropicProviderConfig = Omit<AnthropicProviderConfig, 'defaultModel'> & {
  /** API key for the Anthropic API. */
  apiKey: string;
  /** Model override; defaults to {@link ANTHROPIC_DEFAULT_MODEL}. */
  model?: AnthropicModel;
};

/** Anthropic message parameter shape. */
interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

type AnthropicContent = string | AnthropicContentBlock[];

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    };

/** Anthropic tool definition shape. */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

/** Non-streaming Messages API response. */
interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicResponseContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

type AnthropicResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** Count tokens API response. */
interface AnthropicCountTokensResponse {
  input_tokens: number;
}

/**
 * Concrete {@link BaseProvider} for the Anthropic Claude Messages API (fetch-only, no SDK).
 */
export class AnthropicProvider extends BaseProvider<AnthropicModel> {
  private readonly apiKey: string;
  private readonly anthropicVersion: string;

  /**
   * @param config - Provider configuration including a required `apiKey`.
   */
  constructor(config: AnthropicProviderConfig) {
    if (!config.apiKey) {
      throw new Error('AnthropicProvider requires an apiKey');
    }
    super({
      ...config,
      defaultModel: config.defaultModel ?? ANTHROPIC_DEFAULT_MODEL,
    });
    this.apiKey = config.apiKey;
    this.anthropicVersion = config.anthropicVersion ?? ANTHROPIC_API_VERSION;
  }

  /** @inheritdoc */
  protected async _rawComplete(
    params: CompletionParams<AnthropicModel>,
  ): Promise<CompletionResult<AnthropicModel>> {
    const body = this.buildRequestBody(params, false);
    const response = await this.makeRequest<AnthropicMessageResponse>(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    return this.mapCompletionResponse(response, this.resolveModel(params));
  }

  /** @inheritdoc */
  protected async *_rawStream(
    params: CompletionParams<AnthropicModel>,
  ): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(params, true);
    const response = await this.postStream(ANTHROPIC_MESSAGES_URL, body);

    if (!response.body) {
      throw new ProviderError('Anthropic stream response has no body', {
        code: 'server_error',
        retryable: true,
        originalError: response,
      });
    }

    yield* this.parseAnthropicStream(response.body);
  }

  /** @inheritdoc */
  protected async _countTokens(messages: ChatMessage[]): Promise<number> {
    const { system, messages: anthropicMessages } = splitMessages(messages);
    const body: Record<string, unknown> = {
      model: this.config.defaultModel,
      messages: anthropicMessages,
    };
    if (system) body.system = system;

    const response = await this.makeRequest<AnthropicCountTokensResponse>(
      ANTHROPIC_COUNT_TOKENS_URL,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    return response.input_tokens;
  }

  /** @inheritdoc */
  protected override errorFromHttpResponse(status: number, body: string): ProviderError {
    if (status === 529) {
      return new ProviderError(extractAnthropicErrorMessage(body) ?? 'Anthropic API is overloaded', {
        code: 'server_error',
        retryable: true,
        originalError: { status, body },
      });
    }
    if (status === 429) {
      return new ProviderError(extractAnthropicErrorMessage(body) ?? 'Anthropic rate limit exceeded', {
        code: 'rate_limit',
        retryable: true,
        originalError: { status, body },
      });
    }
    if (status === 401) {
      return new ProviderError(extractAnthropicErrorMessage(body) ?? 'Invalid Anthropic API key', {
        code: 'auth',
        retryable: false,
        originalError: { status, body },
      });
    }
    return super.errorFromHttpResponse(status, body);
  }

  /** Build JSON headers required by the Anthropic API. */
  private buildHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
      'content-type': 'application/json',
    };
  }

  /** Build the Messages API request body from universal params. */
  private buildRequestBody(
    params: CompletionParams<AnthropicModel>,
    stream: boolean,
  ): Record<string, unknown> {
    const { system, messages } = splitMessages(params.messages, params.systemPrompt);
    const body: Record<string, unknown> = {
      model: this.resolveModel(params),
      max_tokens: params.maxTokens ?? 4096,
      messages,
      stream,
    };

    if (system) body.system = system;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.stopSequences?.length) body.stop_sequences = params.stopSequences;
    if (params.tools?.length) body.tools = mapTools(params.tools);

    return body;
  }

  /** POST a streaming request and return the raw `Response` (SSE body). */
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

  /** Map a non-streaming Anthropic response to {@link CompletionResult}. */
  private mapCompletionResponse(
    response: AnthropicMessageResponse,
    model: AnthropicModel,
  ): CompletionResult<AnthropicModel> {
    return {
      content: response.content.map(mapAnthropicBlockToContent),
      model: response.model ?? model,
      usage: mapUsage(response.usage),
      stopReason: response.stop_reason ?? 'end_turn',
    };
  }

  /** Parse Anthropic SSE events into universal {@link StreamChunk}s. */
  private async *parseAnthropicStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
    let stopReason = 'end_turn';
    let usage: TokenUsage | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith('data: ')) continue;

          const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          const eventType = (data.type as string | undefined) ?? currentEvent;

          for (const chunk of mapStreamEvent(eventType, data, toolBlocks)) {
            yield chunk;
          }

          if (eventType === 'message_delta') {
            const delta = data.delta as { stop_reason?: string } | undefined;
            if (delta?.stop_reason) stopReason = delta.stop_reason;
            const u = data.usage as { output_tokens?: number } | undefined;
            if (u?.output_tokens !== undefined && usage) {
              usage.outputTokens = u.output_tokens;
              usage.totalTokens = usage.inputTokens + usage.outputTokens;
            }
          }

          if (eventType === 'message_start') {
            const message = data.message as { usage?: { input_tokens?: number } } | undefined;
            const inputTokens = message?.usage?.input_tokens ?? 0;
            usage = { inputTokens, outputTokens: 0, totalTokens: inputTokens };
          }

          currentEvent = '';
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
 * Create a configured {@link AnthropicProvider} instance.
 *
 * @param config - API key, optional model, and {@link BaseProviderConfig} options.
 */
export function createAnthropicProvider(
  config: CreateAnthropicProviderConfig,
): AnthropicProvider {
  const { apiKey, model, ...rest } = config;
  return new AnthropicProvider({
    ...rest,
    apiKey,
    defaultModel: model ?? ANTHROPIC_DEFAULT_MODEL,
  });
}

/** Split system messages and map the remainder to Anthropic message params. */
function splitMessages(
  messages: ChatMessage[],
  systemPrompt?: string,
): { system?: string; messages: AnthropicMessageParam[] } {
  const systemParts: string[] = [];
  if (systemPrompt) systemParts.push(systemPrompt);

  const anthropicMessages: AnthropicMessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(messageContentToString(message.content));
      continue;
    }

    if (message.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: mapToolRoleContent(message.content),
      });
      continue;
    }

    anthropicMessages.push({
      role: message.role,
      content: mapMessageContent(message.content),
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: anthropicMessages,
  };
}

/** Map universal tool definitions to Anthropic's tool format. */
function mapTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/** Map universal message content to Anthropic content blocks. */
function mapMessageContent(content: string | ContentBlock[]): AnthropicContent {
  if (typeof content === 'string') return content;
  return content.map(mapOutgoingContentBlock);
}

/** Map tool-role message content to Anthropic `tool_result` blocks. */
function mapToolRoleContent(content: string | ContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'tool_result', tool_use_id: 'unknown', content }];
  }
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    .map((block) => ({
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: mapToolResultContent(block.content),
    }));
}

/** Map nested tool result content. */
function mapToolResultContent(content: string | ContentBlock[]): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  return content.map(mapOutgoingContentBlock);
}

/** Map a universal outgoing content block to Anthropic format. */
function mapOutgoingContentBlock(block: ContentBlock): AnthropicContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return { type: 'image', source: mapImageSource(block) };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: mapToolResultContent(block.content),
      };
    default:
      return block satisfies never;
  }
}

/** Map universal image block to Anthropic image source. */
function mapImageSource(
  block: ImageBlock,
): { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } {
  if (block.source.type === 'url') {
    return { type: 'url', url: block.source.data };
  }
  return {
    type: 'base64',
    media_type: block.source.media_type,
    data: block.source.data,
  };
}

/** Map Anthropic response blocks to universal {@link ContentBlock}s. */
function mapAnthropicBlockToContent(block: AnthropicResponseContentBlock): ContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
}

/** Map Anthropic usage to {@link TokenUsage}. */
function mapUsage(usage: { input_tokens: number; output_tokens: number }): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

/** Coerce message content to a plain string for system extraction. */
function messageContentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Map a single SSE event to zero or more stream chunks. */
function* mapStreamEvent(
  eventType: string,
  data: Record<string, unknown>,
  toolBlocks: Map<number, { id: string; name: string; inputJson: string }>,
): Generator<StreamChunk> {
  switch (eventType) {
    case 'content_block_start': {
      const index = data.index as number;
      const block = data.content_block as {
        type: string;
        id?: string;
        name?: string;
      };
      if (block.type === 'tool_use' && block.id && block.name) {
        toolBlocks.set(index, { id: block.id, name: block.name, inputJson: '' });
        yield {
          type: 'tool_use_start',
          data: { id: block.id, name: block.name },
        };
      }
      break;
    }
    case 'content_block_delta': {
      const index = data.index as number;
      const delta = data.delta as {
        type: string;
        text?: string;
        partial_json?: string;
      };
      if (delta.type === 'text_delta' && delta.text) {
        yield { type: 'text_delta', data: { text: delta.text } };
      }
      if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
        const tool = toolBlocks.get(index);
        if (tool) {
          tool.inputJson += delta.partial_json;
          yield {
            type: 'tool_use_delta',
            data: { id: tool.id, partialInput: delta.partial_json },
          };
        }
      }
      break;
    }
    case 'content_block_stop': {
      const index = data.index as number;
      const tool = toolBlocks.get(index);
      if (tool) {
        let input: Record<string, unknown>;
        try {
          input = tool.inputJson ? (JSON.parse(tool.inputJson) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        yield {
          type: 'tool_use_end',
          data: { id: tool.id, name: tool.name, input },
        };
        toolBlocks.delete(index);
      }
      break;
    }
    default:
      break;
  }
}

/** Extract error message from Anthropic JSON error payloads. */
function extractAnthropicErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
    return parsed.error?.message;
  } catch {
    return undefined;
  }
}

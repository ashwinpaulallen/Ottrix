import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CompletionProvider, ToolDefinition } from 'ottrix';

import {
  bindToolsToOttrixDefinitions,
  langChainMessagesToOttrix,
  ottrixCompletionToAIMessage,
} from './messages.js';

/** Call options for {@link OttrixChatModel}. */
export type OttrixChatModelCallOptions = BaseChatModelCallOptions & {
  temperature?: number;
  maxTokens?: number;
};

/** Constructor params for {@link OttrixChatModel}. */
export interface OttrixChatModelParams extends BaseChatModelParams {
  provider: CompletionProvider;
  modelId?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

/** LangChain chat model backed by an ottrix {@link CompletionProvider}. */
export class OttrixChatModel extends BaseChatModel<OttrixChatModelCallOptions> {
  static lc_name(): string {
    return 'OttrixChatModel';
  }

  lc_serializable = true;

  private readonly provider: CompletionProvider;
  private readonly modelId?: string;
  private readonly tools?: ToolDefinition[];
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;

  constructor(fields: OttrixChatModelParams) {
    super(fields);
    this.provider = fields.provider;
    this.modelId = fields.modelId;
    this.tools = fields.tools;
    this.defaultTemperature = fields.temperature;
    this.defaultMaxTokens = fields.maxTokens;
  }

  _llmType(): string {
    return 'ottrix';
  }

  bindTools(tools: BindToolsInput[], kwargs?: Partial<OttrixChatModelCallOptions>): OttrixChatModel {
    return new OttrixChatModel({
      provider: this.provider,
      modelId: this.modelId,
      tools: [...(this.tools ?? []), ...bindToolsToOttrixDefinitions(tools)],
      callbacks: this.callbacks,
      ...kwargs,
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const result = await this.provider.complete({
      messages: langChainMessagesToOttrix(messages),
      model: this.modelId,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
      stopSequences: options?.stop,
      tools: this.tools,
    });

    const message = ottrixCompletionToAIMessage(result);

    return {
      generations: [
        {
          text: typeof message.content === 'string' ? message.content : '',
          message,
          generationInfo: {
            finishReason: result.stopReason,
            model: result.model,
          },
        },
      ],
      llmOutput: {
        tokenUsage: result.usage,
        latency: result.latency,
        metadata: result.metadata,
      },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const params = {
      messages: langChainMessagesToOttrix(messages),
      model: this.modelId,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
      stopSequences: options?.stop,
      tools: this.tools,
    };

    for await (const chunk of this.provider.stream(params)) {
      if (chunk.type === 'text_delta') {
        yield new ChatGenerationChunk({
          text: chunk.data.text,
          message: new AIMessageChunk({ content: chunk.data.text }),
        });
      }

      if (chunk.type === 'tool_use_end') {
        yield new ChatGenerationChunk({
          text: '',
          message: new AIMessageChunk({
            content: '',
            tool_call_chunks: [
              {
                id: chunk.data.id,
                name: chunk.data.name,
                args: JSON.stringify(chunk.data.input ?? {}),
                type: 'tool_call_chunk',
                index: 0,
              },
            ],
          }),
        });
      }
    }
  }
}

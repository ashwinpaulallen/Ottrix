import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from '@ai-sdk/provider';
import type { CompletionProvider, StreamChunk } from 'ottrix';

import { mapStopReasonToFinishReason } from './finish-reason.js';
import {
  ottrixContentToText,
  ottrixContentToToolCalls,
  vercelPromptToOttrixMessages,
  vercelResponseFormat,
  vercelToolsToOttrixDefinitions,
} from './messages.js';

const PROVIDER_NAME = 'ottrix';

/** Options for {@link createOttrixModel}. */
export interface CreateOttrixModelOptions {
  /** Model id passed to ottrix {@link CompletionProvider.complete}. */
  modelId?: string;
  /** Provider label in Vercel metadata. @defaultValue `'ottrix'` */
  providerName?: string;
}

/** Create a Vercel AI SDK {@link LanguageModelV1} backed by an ottrix provider. */
export function createOttrixModel(
  provider: CompletionProvider,
  options: CreateOttrixModelOptions = {},
): LanguageModelV1 {
  const providerName = options.providerName ?? PROVIDER_NAME;
  const modelId = options.modelId ?? 'default';

  return {
    specificationVersion: 'v1',
    provider: providerName,
    modelId,
    defaultObjectGenerationMode: 'json',

    async doGenerate(callOptions) {
      const params = buildCompletionParams(callOptions, modelId);
      const result = await provider.complete(params);
      const text = ottrixContentToText(result.content);
      const toolCalls = ottrixContentToToolCalls(result.content);

      return {
        text: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: mapStopReasonToFinishReason(result.stopReason),
        usage: {
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
        },
        rawCall: {
          rawPrompt: params.messages,
          rawSettings: {
            model: params.model,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            stopSequences: params.stopSequences,
          },
        },
        response: {
          modelId: result.model,
        },
      };
    },

    async doStream(callOptions) {
      const params = buildCompletionParams(callOptions, modelId);

      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        async start(controller) {
          try {
            controller.enqueue({
              type: 'response-metadata',
              modelId: params.model ?? modelId,
            });

            for await (const chunk of provider.stream(params)) {
              for (const part of mapStreamChunk(chunk)) {
                controller.enqueue(part);
              }
            }
            controller.close();
          } catch (error) {
            controller.enqueue({ type: 'error', error });
            controller.close();
          }
        },
      });

      return {
        stream,
        rawCall: {
          rawPrompt: params.messages,
          rawSettings: {
            model: params.model,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            stopSequences: params.stopSequences,
          },
        },
      };
    },
  };
}

function buildCompletionParams(options: LanguageModelV1CallOptions, defaultModelId: string) {
  return {
    messages: vercelPromptToOttrixMessages(options.prompt),
    model: defaultModelId,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    stopSequences: options.stopSequences,
    tools: vercelToolsToOttrixDefinitions(options),
    responseFormat: vercelResponseFormat(options),
  };
}

function mapStreamChunk(chunk: StreamChunk): LanguageModelV1StreamPart[] {
  switch (chunk.type) {
    case 'text_delta':
      return [{ type: 'text-delta', textDelta: chunk.data.text }];
    case 'tool_use_start':
      return [
        {
          type: 'tool-call-delta',
          toolCallType: 'function',
          toolCallId: chunk.data.id,
          toolName: chunk.data.name,
          argsTextDelta: '',
        },
      ];
    case 'tool_use_delta':
      return [
        {
          type: 'tool-call-delta',
          toolCallType: 'function',
          toolCallId: chunk.data.id,
          toolName: '',
          argsTextDelta: chunk.data.partialInput,
        },
      ];
    case 'tool_use_end':
      return [
        {
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: chunk.data.id,
          toolName: chunk.data.name,
          args: JSON.stringify(chunk.data.input ?? {}),
        },
      ];
    case 'done':
      return [
        {
          type: 'finish',
          finishReason: mapStopReasonToFinishReason(chunk.data.stopReason),
          usage: {
            promptTokens: chunk.data.usage?.inputTokens ?? 0,
            completionTokens: chunk.data.usage?.outputTokens ?? 0,
          },
        },
      ];
    default:
      return [];
  }
}

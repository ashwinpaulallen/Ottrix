import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
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

/** Create a Vercel AI SDK {@link LanguageModelV2} backed by an ottrix provider. */
export function createOttrixModel(
  provider: CompletionProvider,
  options: CreateOttrixModelOptions = {},
): LanguageModelV2 {
  const providerName = options.providerName ?? PROVIDER_NAME;
  const modelId = options.modelId ?? 'default';

  return {
    specificationVersion: 'v2',
    provider: providerName,
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions) {
      const params = buildCompletionParams(callOptions, modelId);
      const result = await provider.complete(params);
      const content = buildContent(result.content);

      return {
        content,
        finishReason: mapStopReasonToFinishReason(result.stopReason),
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
        warnings: [],
        response: {
          modelId: result.model,
        },
        request: {
          body: {
            model: params.model,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            stopSequences: params.stopSequences,
          },
        },
      };
    },

    async doStream(callOptions) {
      const params = buildCompletionParams(callOptions, modelId);
      let textStarted = false;
      const textId = 'text-1';

      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          try {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'response-metadata', modelId: params.model ?? modelId });

            for await (const chunk of provider.stream(params)) {
              for (const part of mapStreamChunk(chunk, textId, () => {
                if (!textStarted) {
                  textStarted = true;
                  controller.enqueue({ type: 'text-start', id: textId });
                }
              })) {
                controller.enqueue(part);
              }
            }

            if (textStarted) {
              controller.enqueue({ type: 'text-end', id: textId });
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
        request: {
          body: {
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

function buildCompletionParams(options: LanguageModelV2CallOptions, defaultModelId: string) {
  return {
    messages: vercelPromptToOttrixMessages(options.prompt),
    model: defaultModelId,
    temperature: options.temperature,
    maxTokens: options.maxOutputTokens,
    stopSequences: options.stopSequences,
    tools: vercelToolsToOttrixDefinitions(options),
    responseFormat: vercelResponseFormat(options),
  };
}

function buildContent(content: Parameters<typeof ottrixContentToText>[0]): LanguageModelV2Content[] {
  const parts: LanguageModelV2Content[] = [];
  const text = ottrixContentToText(content);
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const toolCall of ottrixContentToToolCalls(content)) {
    parts.push({
      type: 'tool-call',
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
    });
  }
  return parts;
}

function mapStreamChunk(
  chunk: StreamChunk,
  textId: string,
  onTextStart: () => void,
): LanguageModelV2StreamPart[] {
  switch (chunk.type) {
    case 'text_delta':
      onTextStart();
      return [{ type: 'text-delta', id: textId, delta: chunk.data.text }];
    case 'tool_use_start':
      return [
        {
          type: 'tool-input-start',
          id: chunk.data.id,
          toolName: chunk.data.name,
        },
      ];
    case 'tool_use_delta':
      return [
        {
          type: 'tool-input-delta',
          id: chunk.data.id,
          delta: chunk.data.partialInput,
        },
      ];
    case 'tool_use_end':
      return [
        { type: 'tool-input-end', id: chunk.data.id },
        {
          type: 'tool-call',
          toolCallId: chunk.data.id,
          toolName: chunk.data.name,
          input: JSON.stringify(chunk.data.input ?? {}),
        },
      ];
    case 'done':
      return [
        {
          type: 'finish',
          finishReason: mapStopReasonToFinishReason(chunk.data.stopReason),
          usage: {
            inputTokens: chunk.data.usage?.inputTokens,
            outputTokens: chunk.data.usage?.outputTokens,
            totalTokens: chunk.data.usage?.totalTokens,
          },
        },
      ];
    default:
      return [];
  }
}

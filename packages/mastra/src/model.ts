import type { LanguageModelV1, LanguageModelV1CallOptions } from '@ai-sdk/provider';
import type { ChatMessage, CompletionProvider, ContentBlock } from 'ottrix';
/** Mastra-compatible language model backed by an ottrix provider. */
export type MastraModel = LanguageModelV1;

/** Options for {@link createOttrixMastraModel}. */
export interface CreateOttrixMastraModelOptions {
  /** Model id passed to ottrix {@link CompletionProvider.complete}. */
  modelId?: string;
}

type CreateOttrixModel = (
  provider: CompletionProvider,
  options?: { modelId?: string; providerName?: string },
) => LanguageModelV1;

/** Wrap an ottrix provider as a Mastra language model (Vercel AI SDK v1). */
export function createOttrixMastraModel(
  provider: CompletionProvider,
  options: CreateOttrixMastraModelOptions = {},
): MastraModel {
  const createFromPeer = loadVercelAiModelFactory();
  if (createFromPeer) {
    return createFromPeer(provider, options);
  }
  return createDirectOttrixModel(provider, options);
}

function loadVercelAiModelFactory(): CreateOttrixModel | undefined {
  try {
    // Optional peer — resolved at runtime when @ottrix/vercel-ai is installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@ottrix/vercel-ai') as { createOttrixModel?: CreateOttrixModel };
    return mod.createOttrixModel;
  } catch {
    return undefined;
  }
}

function createDirectOttrixModel(
  provider: CompletionProvider,
  options: CreateOttrixMastraModelOptions,
): LanguageModelV1 {
  const modelId = options.modelId ?? 'default';

  return {
    specificationVersion: 'v1',
    provider: 'ottrix',
    modelId,
    defaultObjectGenerationMode: 'json',

    async doGenerate(callOptions) {
      const params = {
        messages: promptToMessages(callOptions),
        model: modelId,
        temperature: callOptions.temperature,
        maxTokens: callOptions.maxTokens,
        stopSequences: callOptions.stopSequences,
      };
      const result = await provider.complete(params);
      const text = contentToText(result.content);

      return {
        text: text || undefined,
        finishReason: mapStopReason(result.stopReason),
        usage: {
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
        },
        rawCall: { rawPrompt: params.messages, rawSettings: { model: modelId } },
        response: { modelId: result.model },
      };
    },

    async doStream() {
      throw new Error('Streaming requires @ottrix/vercel-ai to be installed');
    },
  };
}

function promptToMessages(options: LanguageModelV1CallOptions): ChatMessage[] {
  return options.prompt.map((message) => {
    if (message.role === 'system') {
      return { role: 'system' as const, content: message.content };
    }

    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text };
            }
            if (part.type === 'tool-result') {
              return {
                type: 'tool_result' as const,
                tool_use_id: part.toolCallId,
                content: part.result,
              };
            }
            return { type: 'text' as const, text: JSON.stringify(part) };
          });

    return { role: message.role, content } as ChatMessage;
  });
}

function contentToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function mapStopReason(
  stopReason: string,
): 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown' {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'unknown';
  }
}

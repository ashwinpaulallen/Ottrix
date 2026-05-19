import type { ChatMessage, ContentBlock } from '../../src/types/messages.js';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from '../../src/types/provider.js';

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/**
 * Queue-driven mock {@link CompletionProvider} for agent unit tests.
 */
export class MockCompletionProvider implements CompletionProvider {
  private readonly completeQueue: CompletionResult[] = [];
  private readonly streamQueue: CompletionResult[] = [];
  private tokenCount = 100;

  /** Enqueue the next `complete()` response. */
  enqueue(result: CompletionResult): this {
    this.completeQueue.push(result);
    return this;
  }

  /** Enqueue the next `stream()` response (falls back to complete queue). */
  enqueueStream(result: CompletionResult): this {
    this.streamQueue.push(result);
    return this;
  }

  /** Fixed token count returned by `countTokens`. */
  setTokenCount(count: number): this {
    this.tokenCount = count;
    return this;
  }

  /** Number of times `complete` was invoked. */
  completeCalls = 0;

  /** Last params passed to `complete`. */
  lastCompleteParams?: CompletionParams;

  async complete(params: CompletionParams): Promise<CompletionResult> {
    this.completeCalls += 1;
    this.lastCompleteParams = params;
    const next = this.completeQueue.shift();
    if (!next) {
      throw new Error('MockCompletionProvider: no more complete() responses queued');
    }
    return next;
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    this.lastCompleteParams = params;
    const next = this.streamQueue.shift() ?? this.completeQueue[0];
    if (!next) {
      throw new Error('MockCompletionProvider: no more stream() responses queued');
    }

    for (const block of next.content) {
      if (block.type === 'text') {
        yield { type: 'text_delta', data: { text: block.text } };
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', data: { id: block.id, name: block.name } };
        yield {
          type: 'tool_use_end',
          data: { id: block.id, name: block.name, input: block.input },
        };
      }
    }

    yield {
      type: 'done',
      data: { stopReason: next.stopReason, usage: next.usage },
    };
  }

  async countTokens(_messages: ChatMessage[]): Promise<number> {
    return this.tokenCount;
  }
}

/** Build a text-only completion result. */
export function textCompletion(text: string, usage: TokenUsage = DEFAULT_USAGE): CompletionResult {
  return {
    content: [{ type: 'text', text }],
    model: 'mock-model',
    usage,
    stopReason: 'end_turn',
  };
}

/** Build a tool-use completion result. */
export function toolUseCompletion(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  usage: TokenUsage = DEFAULT_USAGE,
): CompletionResult {
  const content: ContentBlock[] = tools.map((t) => ({
    type: 'tool_use' as const,
    id: t.id,
    name: t.name,
    input: t.input,
  }));
  return {
    content,
    model: 'mock-model',
    usage,
    stopReason: 'tool_use',
  };
}

/** Build a completion with optional text plus tool calls. */
export function mixedCompletion(
  text: string | undefined,
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  usage: TokenUsage = DEFAULT_USAGE,
): CompletionResult {
  const content: ContentBlock[] = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const t of tools) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
  }
  return {
    content,
    model: 'mock-model',
    usage,
    stopReason: tools.length > 0 ? 'tool_use' : 'end_turn',
  };
}

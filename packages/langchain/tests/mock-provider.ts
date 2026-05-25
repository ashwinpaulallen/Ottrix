import type { ChatMessage, ContentBlock } from 'ottrix';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from 'ottrix';

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

export class MockCompletionProvider implements CompletionProvider {
  private readonly completeQueue: CompletionResult[] = [];
  private readonly streamQueue: CompletionResult[] = [];

  completeCalls = 0;
  streamCalls = 0;
  lastCompleteParams?: CompletionParams;

  enqueue(result: CompletionResult): this {
    this.completeQueue.push(result);
    return this;
  }

  enqueueStream(result: CompletionResult): this {
    this.streamQueue.push(result);
    return this;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    this.completeCalls += 1;
    this.lastCompleteParams = params;
    const next = this.completeQueue.shift();
    if (!next) {
      throw new Error('MockCompletionProvider: no complete() responses queued');
    }
    return next;
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    this.streamCalls += 1;
    const next = this.streamQueue.shift() ?? this.completeQueue[0];
    if (!next) {
      throw new Error('MockCompletionProvider: no stream() responses queued');
    }

    for (const block of next.content) {
      if (block.type === 'text') {
        yield { type: 'text_delta', data: { text: block.text } };
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_end', data: { id: block.id, name: block.name, input: block.input } };
      }
    }

    yield {
      type: 'done',
      data: { stopReason: next.stopReason, usage: next.usage },
    };
  }

  async countTokens(_messages: ChatMessage[]): Promise<number> {
    return 42;
  }
}

export function textCompletion(text: string, usage: TokenUsage = DEFAULT_USAGE): CompletionResult {
  return {
    content: [{ type: 'text', text }],
    model: 'mock-model',
    usage,
    stopReason: 'end_turn',
    latency: { ttft: 1, totalTime: 10, tokensPerSecond: usage.outputTokens / 0.01 },
  };
}

export function toolUseCompletion(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  usage: TokenUsage = DEFAULT_USAGE,
): CompletionResult {
  const content: ContentBlock[] = tools.map((tool) => ({
    type: 'tool_use' as const,
    id: tool.id,
    name: tool.name,
    input: tool.input,
  }));
  return {
    content,
    model: 'mock-model',
    usage,
    stopReason: 'tool_use',
    latency: { ttft: 1, totalTime: 10, tokensPerSecond: usage.outputTokens / 0.01 },
  };
}

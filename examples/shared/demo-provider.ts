import type {
  ChatMessage,
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from 'agentic-fabric';

const USAGE: TokenUsage = { inputTokens: 8, outputTokens: 12, totalTokens: 20 };

/**
 * Deterministic mock LLM for examples — no API key required.
 * Queues {@link CompletionResult} values for `complete` / `stream`.
 */
export class DemoProvider implements CompletionProvider {
  private readonly queue: CompletionResult[] = [];
  completeCalls = 0;

  enqueue(result: CompletionResult): this {
    this.queue.push(result);
    return this;
  }

  textReply(text: string): this {
    return this.enqueue({
      content: [{ type: 'text', text }],
      model: 'demo-model',
      usage: USAGE,
      stopReason: 'end_turn',
    });
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    this.completeCalls += 1;
    const next = this.queue.shift();
    if (next) {
      return next;
    }
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    const userText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : '(no user message)';
    return this.fallback(`(demo mode) Echo: ${userText}`);
  }

  async *stream(params: CompletionParams): AsyncGenerator<StreamChunk> {
    const result = await this.complete(params);
    for (const block of result.content) {
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
    yield { type: 'done', data: { stopReason: result.stopReason, usage: result.usage } };
  }

  async countTokens(_messages: ChatMessage[]): Promise<number> {
    return 50;
  }

  private fallback(text: string): CompletionResult {
    return {
      content: [{ type: 'text', text }],
      model: 'demo-model',
      usage: USAGE,
      stopReason: 'end_turn',
    };
  }
}

/** Build a tool-use completion for the demo provider queue. */
export function demoToolUse(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): CompletionResult {
  return {
    content: tools.map((t) => ({
      type: 'tool_use' as const,
      id: t.id,
      name: t.name,
      input: t.input,
    })),
    model: 'demo-model',
    usage: USAGE,
    stopReason: 'tool_use',
  };
}

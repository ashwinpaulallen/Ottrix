import type { ChatMessage } from '../../src/types/messages.js';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from '../../src/types/provider.js';

export {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
  mixedCompletion,
} from '../fixtures/mock-provider.js';

/** Alias matching integration docs — same as {@link MockCompletionProvider}. */
export { MockCompletionProvider as MockProvider } from '../fixtures/mock-provider.js';

/** Default token usage for mock completions. */
export const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};

export const lightUsage: TokenUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

export const heavyUsage: TokenUsage = {
  inputTokens: 500,
  outputTokens: 300,
  totalTokens: 800,
};

/**
 * Provider whose `stream()` can be cancelled by the consumer breaking the async iterator.
 * Sets `streamClosed` when the generator is closed.
 */
export class CancellableStreamProvider implements CompletionProvider {
  streamStarted = false;
  streamClosed = false;
  completeCalls = 0;

  constructor(
    private readonly chunks: StreamChunk[],
    private readonly done: CompletionResult,
  ) {}

  async complete(_params: CompletionParams): Promise<CompletionResult> {
    this.completeCalls += 1;
    return this.done;
  }

  async *stream(_params: CompletionParams): AsyncGenerator<StreamChunk> {
    this.streamStarted = true;
    try {
      for (const chunk of this.chunks) {
        yield chunk;
      }
    } finally {
      this.streamClosed = true;
    }
  }

  async countTokens(_messages: ChatMessage[]): Promise<number> {
    return 10;
  }
}

/** Delay helper for slow-stream scenarios. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

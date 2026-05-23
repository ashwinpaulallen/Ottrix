import type {
  CompletionLatency,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from '../types/provider.js';

/** Compute normalized latency metrics for a completion. */
export function computeCompletionLatency(options: {
  ttftMs: number;
  totalTimeMs: number;
  outputTokens: number;
}): CompletionLatency {
  const totalTime = Math.max(0, options.totalTimeMs);
  const ttft = Math.max(0, options.ttftMs);
  const tokensPerSecond =
    totalTime > 0 ? options.outputTokens / (totalTime / 1000) : 0;

  return { ttft, totalTime, tokensPerSecond };
}

/** Zeroed latency placeholder when timing is unavailable. */
export function unknownCompletionLatency(): CompletionLatency {
  return { ttft: 0, totalTime: 0, tokensPerSecond: 0 };
}

/** Ensure a {@link CompletionResult} includes latency metrics. */
export function ensureCompletionLatency(
  result: Omit<CompletionResult, 'latency'> & { latency?: CompletionLatency },
): CompletionResult {
  if (result.latency) {
    return result as CompletionResult;
  }

  return {
    ...result,
    latency: computeCompletionLatency({
      ttftMs: 0,
      totalTimeMs: 0,
      outputTokens: result.usage.outputTokens,
    }),
  };
}

/** Attach a high-resolution timestamp to a stream chunk. */
export function stampStreamChunk<T extends StreamChunk>(
  chunk: T,
  timestamp = performance.now(),
): T {
  return { ...chunk, timestamp };
}

/** Attach computed latency to a terminal `done` chunk. */
export function attachStreamLatency(
  chunk: StreamChunk,
  latency: CompletionLatency,
): StreamChunk {
  if (chunk.type !== 'done') {
    return chunk;
  }

  return {
    ...chunk,
    data: {
      ...chunk.data,
      latency,
    },
  };
}

/** Resolve output token count from a stream terminal chunk. */
export function outputTokensFromStreamDone(usage?: TokenUsage): number {
  return usage?.outputTokens ?? 0;
}

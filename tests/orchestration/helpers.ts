import { Agent } from '../../src/agent/agent.js';
import type { AgentResult } from '../../src/types/agent.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const DEFAULT_USAGE: TokenUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

/** Build a minimal successful {@link AgentResult}. */
export function result(response: string, usage: TokenUsage = DEFAULT_USAGE): AgentResult {
  return {
    response,
    steps: [],
    totalTokens: usage,
    metadata: { stopReason: 'completed' },
  };
}

/** Create an agent that returns a fixed text response. */
export function createTextAgent(name: string, response: string): Agent {
  const provider = new MockCompletionProvider().enqueue(textCompletion(response, DEFAULT_USAGE));
  return new Agent({ name, provider });
}

/** Create an agent that invokes a tool then responds. */
export function createToolThenTextAgent(
  name: string,
  tool: { id: string; name: string; input: Record<string, unknown> },
  finalText: string,
): Agent {
  const provider = new MockCompletionProvider()
    .enqueue(toolUseCompletion([tool], DEFAULT_USAGE))
    .enqueue(textCompletion(finalText, DEFAULT_USAGE));

  return new Agent({ name, provider });
}

/** Promise that resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

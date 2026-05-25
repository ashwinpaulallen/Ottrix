import { Agent as MastraAgent } from '@mastra/core/agent';
import type { FullOutput } from '@mastra/core/stream';
import type { Agent as OttrixAgent } from 'ottrix';

import { createOttrixMastraModel } from './model.js';

/** Mastra agent wrapper around an ottrix agent. */
export type { MastraAgent };

type MessageListInput = Parameters<MastraAgent['generate']>[0];

const STUB_PROVIDER = {
  name: 'ottrix-mastra-stub',
  async complete(): Promise<never> {
    throw new Error('Model not used — wrapped ottrix agent handles generation');
  },
  async *stream(): AsyncIterable<never> {
    throw new Error('Model not used — wrapped ottrix agent handles generation');
  },
  async countTokens(): Promise<number> {
    return 0;
  },
};

/**
 * Wrap an ottrix {@link Agent} as a Mastra agent.
 *
 * Delegates `generate()` to ottrix's run loop so RunContext, guardrails, and
 * fallback chains stay intact while the agent can participate in Mastra workflows.
 */
export function wrapOttrixAgent(ottrixAgent: OttrixAgent): MastraAgent {
  const name = ottrixAgent.getName();

  const wrapped = new MastraAgent({
    id: name,
    name,
    instructions: `Ottrix agent "${name}"`,
    model: createOttrixMastraModel(STUB_PROVIDER, { modelId: 'stub' }),
  });

  wrapped.generate = (async (messages: MessageListInput) => {
    const input = extractPrompt(messages);
    const result = await ottrixAgent.run(input);
    return toFullOutput(result.response, result.totalTokens);
  }) as MastraAgent['generate'];

  return wrapped;
}

function extractPrompt(messages: MessageListInput): string {
  if (typeof messages === 'string') {
    return messages;
  }

  const items = Array.isArray(messages) ? messages : [messages];
  const parts: string[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }

    if ('content' in item) {
      const { content } = item;
      if (typeof content === 'string') {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'string') {
            parts.push(block);
          } else if (block && typeof block === 'object' && 'text' in block) {
            parts.push(String((block as { text: unknown }).text));
          }
        }
      }
    }
  }

  return parts.join('\n').trim();
}

function toFullOutput(
  text: string,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
): FullOutput {
  const tokenUsage = {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };

  return {
    text,
    usage: tokenUsage,
    totalUsage: tokenUsage,
    finishReason: 'stop',
    steps: [],
    warnings: [],
    providerMetadata: {},
    request: {},
    reasoning: [],
    reasoningText: undefined,
    toolCalls: [],
    toolResults: [],
    sources: [],
    files: [],
    response: {},
    object: undefined,
    error: undefined,
    tripwire: undefined,
    suspendPayload: undefined,
    traceId: undefined,
    spanId: undefined,
    runId: undefined,
    messages: [],
    rememberedMessages: [],
  };
}

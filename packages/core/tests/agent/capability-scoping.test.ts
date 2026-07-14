import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import { ContextManager } from '../../src/agent/context.js';
import { LLMEvaluator } from '../../src/agent/evaluation/llm-evaluator.js';
import { EvaluationConfigSchema } from '../../src/agent/evaluation/types.js';
import {
  withCapabilityScope,
  withTokenAccounting,
} from '../../src/observability/token-accounting/context.js';
import { CAPABILITY } from '../../src/observability/token-accounting/types.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ChatMessage } from '../../src/types/messages.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const llmUsage: TokenUsage = { inputTokens: 100, outputTokens: 40, totalTokens: 140 };
const evalUsage: TokenUsage = { inputTokens: 30, outputTokens: 10, totalTokens: 40 };
const summaryUsage: TokenUsage = { inputTokens: 50, outputTokens: 15, totalTokens: 65 };

const substantiveAnswer =
  'The capital of France is Paris. It has been the political and cultural center for centuries.';

function evalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sufficient: true,
    confidence: 0.95,
    reason: 'Fully answers the question',
    suggestedAction: 'finalize',
    ...overrides,
  });
}

describe('capability scoping for evaluation and summarization', () => {
  it("evaluation tokens attributed to '_evaluation', not '_llm'", async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(evalJson(), evalUsage),
    );
    const evaluator = new LLMEvaluator(
      provider,
      EvaluationConfigSchema.parse({ enabled: true }),
    );

    await withTokenAccounting('eval-scope', async (acc) => {
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        await evaluator.evaluate({
          originalGoal: 'What is the capital of France?',
          currentResponse: substantiveAnswer,
          conversationHistory: [],
          refinementNumber: 0,
          stepsSoFar: 1,
          toolsAvailable: [],
          toolsUsed: [],
        });
      });

      const breakdown = acc.getBreakdown();
      expect(breakdown.byCapability[CAPABILITY.EVALUATION]?.inputTokens).toBe(30);
      expect(breakdown.byCapability[CAPABILITY.EVALUATION]?.outputTokens).toBe(10);
      expect(breakdown.byCapability[CAPABILITY.LLM]?.inputTokens ?? 0).toBe(0);
    });
  });

  it("summarization tokens attributed to '_summarization', not '_llm'", async () => {
    const provider = new MockCompletionProvider()
      .setTokenCount(1000)
      .enqueue(textCompletion('Earlier turns covered Paris history.', summaryUsage));

    const manager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      keepRecentMessages: 1,
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
    ];

    await withTokenAccounting('summary-scope', async (acc) => {
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        await manager.maybeSummarize(messages);
      });

      const breakdown = acc.getBreakdown();
      expect(breakdown.byCapability[CAPABILITY.SUMMARIZATION]?.inputTokens).toBe(50);
      expect(breakdown.byCapability[CAPABILITY.SUMMARIZATION]?.outputTokens).toBe(15);
      expect(breakdown.byCapability[CAPABILITY.LLM]?.inputTokens ?? 0).toBe(0);
      expect(messages.some((m) => String(m.content).includes('Conversation summary'))).toBe(
        true,
      );
    });
  });

  it("run with evaluation: breakdown has both '_llm' and '_evaluation' entries", async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, llmUsage))
      .enqueue(textCompletion(evalJson(), evalUsage));

    const agent = new Agent({
      name: 'cap-eval',
      provider,
      evaluation: { enabled: true, threshold: 0.8 },
    });

    const result = await agent.run('What is the capital of France?');
    const byCapability = result.tokenBreakdown!.byCapability;

    expect(byCapability[CAPABILITY.LLM]?.inputTokens).toBe(100);
    expect(byCapability[CAPABILITY.EVALUATION]?.inputTokens).toBe(30);
    expect(byCapability[CAPABILITY.LLM]?.calls).toBe(1);
    expect(byCapability[CAPABILITY.EVALUATION]?.calls).toBe(1);
  });

  it("run with summarization: breakdown has '_summarization' entry", async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'noop',
        description: 'No-op',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      }),
    );

    const provider = new MockCompletionProvider()
      .setTokenCount(1000)
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'noop', input: {} }], llmUsage))
      .enqueue(textCompletion('Summary of earlier conversation.', summaryUsage))
      .enqueue(textCompletion(substantiveAnswer, llmUsage));

    const agent = new Agent({
      name: 'cap-summary',
      provider,
      toolRegistry: registry,
      contextLimitTokens: 100,
      keepRecentMessages: 1,
    });

    const result = await agent.run('Trigger summarization via tool turn');
    const byCapability = result.tokenBreakdown!.byCapability;

    expect(byCapability[CAPABILITY.SUMMARIZATION]).toBeDefined();
    expect(byCapability[CAPABILITY.SUMMARIZATION]!.inputTokens).toBe(50);
    expect(byCapability[CAPABILITY.LLM]).toBeDefined();
  });
});

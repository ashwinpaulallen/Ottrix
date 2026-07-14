import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import {
  createTokenPricing,
  useTokenPricing,
} from '../../src/observability/token-accounting/cost-attribution.js';
import {
  formatTokenBreakdown,
  recordTokens,
  withTokenAccounting,
} from '../../src/observability/token-accounting/index.js';
import { CAPABILITY } from '../../src/observability/token-accounting/types.js';
import { SupervisorWorkflow } from '../../src/orchestration/supervisor.js';
import {
  ANTHROPIC_DEFAULT_MODEL,
  createAnthropicProvider,
} from '../../src/providers/anthropic.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const llmUsage: TokenUsage = { inputTokens: 100, outputTokens: 40, totalTokens: 140 };
const evalUsage: TokenUsage = { inputTokens: 30, outputTokens: 10, totalTokens: 40 };
const summaryUsage: TokenUsage = { inputTokens: 50, outputTokens: 15, totalTokens: 65 };
const lightUsage: TokenUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
const workerUsage: TokenUsage = { inputTokens: 200, outputTokens: 80, totalTokens: 280 };

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

function registerTools(registry: ToolRegistry): void {
  registry.register(
    new FunctionTool({
      name: 'search',
      description: 'Search',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
      execute: async () => ({ hits: ['a'] }),
    }),
  );
  registry.register(
    new FunctionTool({
      name: 'calculator',
      description: 'Calculate',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      execute: async () => ({ result: 42 }),
    }),
  );
}

describe('integration: token attribution', () => {
  afterEach(() => {
    useTokenPricing(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('full run: breakdown has entries for _llm and each tool used', async () => {
    const registry = new ToolRegistry();
    registerTools(registry);

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            { id: 'tu_1', name: 'search', input: { q: 'paris' } },
            { id: 'tu_2', name: 'calculator', input: { expression: '40+2' } },
          ],
          llmUsage,
        ),
      )
      .enqueue(textCompletion(substantiveAnswer, llmUsage));

    const agent = new Agent({
      name: 'attr-full',
      provider,
      toolRegistry: registry,
    });

    const result = await agent.run('Search and calculate');
    const byCapability = result.tokenBreakdown!.byCapability;

    expect(byCapability[CAPABILITY.LLM]).toBeDefined();
    expect(byCapability['tool:search']).toBeDefined();
    expect(byCapability['tool:calculator']).toBeDefined();
    expect(byCapability[CAPABILITY.LLM]!.calls).toBe(2);
  });

  it('run with evaluation: _evaluation entry present and separate from _llm', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, llmUsage))
      .enqueue(textCompletion(evalJson(), evalUsage));

    const agent = new Agent({
      name: 'attr-eval',
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

  it('run with summarization: _summarization entry present', async () => {
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
      name: 'attr-summary',
      provider,
      toolRegistry: registry,
      contextLimitTokens: 100,
      keepRecentMessages: 1,
    });

    const result = await agent.run('Trigger summarization via tool turn');
    expect(result.tokenBreakdown!.byCapability[CAPABILITY.SUMMARIZATION]).toBeDefined();
    expect(result.tokenBreakdown!.byCapability[CAPABILITY.SUMMARIZATION]!.inputTokens).toBe(50);
  });

  it('parallel tool calls: each attributed separately', async () => {
    const registry = new ToolRegistry();
    registerTools(registry);

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            { id: 'tu_1', name: 'search', input: { q: 'ai' } },
            { id: 'tu_2', name: 'calculator', input: { expression: '1+1' } },
          ],
          llmUsage,
        ),
      )
      .enqueue(textCompletion('Done.', llmUsage));

    const agent = new Agent({
      name: 'attr-parallel',
      provider,
      toolRegistry: registry,
    });

    const result = await agent.run('Do both');
    const byCapability = result.tokenBreakdown!.byCapability;

    expect(byCapability['tool:search']).toBeDefined();
    expect(byCapability['tool:calculator']).toBeDefined();
    expect(byCapability['tool:search']).not.toBe(byCapability['tool:calculator']);
  });

  it('formatTokenBreakdown: readable output for a real breakdown', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(substantiveAnswer, llmUsage),
    );
    const agent = new Agent({ name: 'attr-format', provider });

    const result = await agent.run('What is the capital of France?');
    const text = formatTokenBreakdown(result.tokenBreakdown!);

    expect(text).toContain(`Token usage for run ${result.tokenBreakdown!.runId}:`);
    expect(text).toContain('By capability:');
    expect(text).toContain(`${CAPABILITY.LLM}:`);
    expect(text).toContain('tokens');
  });

  it('cost attachment: totalCostUsd matches sum of byCapability costs', async () => {
    useTokenPricing(
      createTokenPricing({
        inputPer1kTokens: 1,
        outputPer1kTokens: 2,
      }),
    );

    const provider = new MockCompletionProvider().enqueue(
      textCompletion(substantiveAnswer, llmUsage),
    );
    const agent = new Agent({ name: 'attr-cost', provider });

    const result = await agent.run('What is the capital of France?');
    const breakdown = result.tokenBreakdown!;

    expect(breakdown.totalCostUsd).toBeDefined();
    const capabilitySum = Object.values(breakdown.byCapability).reduce(
      (sum, usage) => sum + (usage.costUsd ?? 0),
      0,
    );
    expect(breakdown.totalCostUsd).toBeCloseTo(capabilitySum, 8);
    // 100/1000*1 + 40/1000*2 = 0.18
    expect(breakdown.byCapability[CAPABILITY.LLM]?.costUsd).toBeCloseTo(0.18, 6);
  });

  it('cache tokens: attributed correctly when Anthropic caching is active', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL) => {
        const href = String(url);
        // countTokens hits a different endpoint; messages returns cache usage.
        if (href.includes('count_tokens')) {
          return new Response(JSON.stringify({ input_tokens: 12 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            id: 'msg_cache',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: substantiveAnswer }],
            model: ANTHROPIC_DEFAULT_MODEL,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 90,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      requestsPerMinute: 10_000,
      maxRetries: 0,
      providerId: 'anthropic',
    });
    const agent = new Agent({ name: 'attr-cache', provider });

    const result = await agent.run('Hi');
    const breakdown = result.tokenBreakdown!;

    expect(breakdown.totalCacheReadTokens).toBe(200);
    expect(breakdown.totalCacheWriteTokens).toBe(90);
    expect(breakdown.byCapability[CAPABILITY.LLM]?.cacheReadTokens).toBe(200);
    expect(breakdown.byCapability[CAPABILITY.LLM]?.cacheWriteTokens).toBe(90);
  });

  it('no accumulator outside run: recordTokens is a no-op (no throw)', () => {
    expect(() =>
      recordTokens({
        inputTokens: 10,
        outputTokens: 5,
      }),
    ).not.toThrow();
  });

  it('nested runs (supervisor + worker): each has its OWN breakdown (ALS isolation)', async () => {
    const workerProvider = new MockCompletionProvider().enqueue(
      textCompletion('Worker research findings.', workerUsage),
    );
    const workers = new Map([
      ['researcher', new Agent({ name: 'researcher', provider: workerProvider })],
    ]);

    const supervisorProvider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            {
              id: 'tu_1',
              name: 'delegate',
              input: { worker: 'researcher', task: 'Research RLHF basics' },
            },
          ],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Final synthesized answer.', lightUsage));

    const registry = new ToolRegistry();
    const supervisor = new Agent({
      name: 'supervisor',
      provider: supervisorProvider,
      toolRegistry: registry,
      systemPrompt: SupervisorWorkflow.buildWorkerSystemPrompt(workers),
    });

    const workflow = new SupervisorWorkflow({
      supervisor,
      workers,
      toolRegistry: registry,
    });

    const result = await workflow.run('Write a blog post about RLHF');
    const supervisorBreakdown = result.finalResult.tokenBreakdown!;
    const workerBreakdown = result.delegations[0]!.result.tokenBreakdown!;

    expect(supervisorBreakdown).toBeDefined();
    expect(workerBreakdown).toBeDefined();

    // Separate accumulators (ALS isolation): worker LLM usage stays on the worker.
    expect(workerBreakdown.byCapability[CAPABILITY.LLM]?.inputTokens).toBe(200);
    expect(workerBreakdown.byCapability[CAPABILITY.LLM]?.outputTokens).toBe(80);
    expect(supervisorBreakdown.byCapability[CAPABILITY.LLM]?.inputTokens).toBe(10);
    expect(supervisorBreakdown.totalTokens).not.toBe(workerBreakdown.totalTokens);

    // Worker LLM tokens must not leak into the supervisor accumulator.
    expect(supervisorBreakdown.totalInputTokens).toBeLessThan(workerUsage.inputTokens);
    expect(supervisorBreakdown.totalTokens).toBe(16); // 2 supervisor LLM calls × lightUsage
  });

  it('tokenBreakdown on AgentResult is always present when run completes', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(substantiveAnswer, llmUsage),
    );
    const agent = new Agent({ name: 'attr-always', provider });

    const result = await agent.run('What is the capital of France?');

    expect(result.tokenBreakdown).toBeDefined();
    expect(result.tokenBreakdown!.runId).toBeTruthy();
    expect(result.tokenBreakdown!.totalCalls).toBeGreaterThan(0);
  });

  it('withTokenAccounting creates an isolated accumulator for nested scopes', async () => {
    await withTokenAccounting('outer', async (outer) => {
      recordTokens({ inputTokens: 1, outputTokens: 1 });
      await withTokenAccounting('inner', async (inner) => {
        recordTokens({ inputTokens: 50, outputTokens: 25 });
        expect(inner.getBreakdown().totalInputTokens).toBe(50);
        expect(outer.getBreakdown().totalInputTokens).toBe(1);
      });
      expect(outer.getBreakdown().totalInputTokens).toBe(1);
    });
  });
});

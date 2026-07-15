import { describe, expect, it } from 'vitest';

import {
  withCapabilityScope,
  withTokenAccounting,
} from '../../src/observability/token-accounting/context.js';
import { CAPABILITY } from '../../src/observability/token-accounting/types.js';
import { BaseProvider, type BaseProviderConfig } from '../../src/providers/base.js';
import { computeCompletionLatency } from '../../src/providers/latency.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { CompletionResult } from '../../src/types/provider.js';

class ToolLlmProvider extends BaseProvider {
  constructor(
    private readonly result: CompletionResult,
    config: BaseProviderConfig = {
      defaultModel: 'tool-model',
      providerId: 'tool-llm',
    },
  ) {
    super({ ...config, circuitBreakerDisabled: true, requestsPerMinute: 10_000 });
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    return this.result;
  }

  protected async *_rawStream(): AsyncGenerator<never> {
    throw new Error('stream not used');
  }

  protected async _countTokens(): Promise<number> {
    return 1;
  }
}

describe('ToolRegistry token accounting', () => {
  it("tool execution attributed to 'tool:toolname'", async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'echo',
        description: 'Echo',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: async (input: Record<string, unknown>) => ({
          text: typeof input.text === 'string' ? input.text : '',
        }),
      }),
    );

    await withTokenAccounting('run-tool-1', async (acc) => {
      await registry.execute('echo', { text: 'hi' });

      expect(acc.hasScope('tool:echo')).toBe(true);
      expect(acc.getBreakdown().byCapability['tool:echo']).toEqual(
        expect.objectContaining({
          capability: 'tool:echo',
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      );
    });
  });

  it("tool that makes LLM calls: LLM tokens attributed to the tool's scope", async () => {
    const provider = new ToolLlmProvider({
      content: [{ type: 'text', text: 'summary' }],
      model: 'tool-model',
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
      stopReason: 'stop',
      latency: computeCompletionLatency({ ttftMs: 1, totalTimeMs: 2, outputTokens: 12 }),
    });

    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'summarize',
        description: 'Summarize via LLM',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: async (input: Record<string, unknown>) => {
          const text = typeof input.text === 'string' ? input.text : '';
          const completion = await provider.complete({
            messages: [{ role: 'user', content: text }],
          });
          return { summary: completion.content };
        },
      }),
    );

    await withTokenAccounting('run-tool-llm', async (acc) => {
      // Outer LLM scope should not receive the tool's internal LLM tokens
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        await registry.execute('summarize', { text: 'long document' });
      });

      const breakdown = acc.getBreakdown();
      expect(breakdown.byCapability['tool:summarize']?.inputTokens).toBe(40);
      expect(breakdown.byCapability['tool:summarize']?.outputTokens).toBe(12);
      expect(breakdown.byCapability['tool:summarize']?.calls).toBe(1);
      expect(breakdown.byCapability[CAPABILITY.LLM]?.inputTokens ?? 0).toBe(0);
    });
  });

  it('multiple tools: each has separate capability entry', async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'search',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
        execute: async () => ({ hits: [] }),
      }),
    );
    registry.register(
      new FunctionTool({
        name: 'calculator',
        description: 'Calc',
        inputSchema: {
          type: 'object',
          properties: { expression: { type: 'string' } },
          required: ['expression'],
        },
        execute: async () => ({ result: 1 }),
      }),
    );

    await withTokenAccounting('run-multi-tool', async (acc) => {
      await registry.execute('search', { q: 'paris' });
      await registry.execute('calculator', { expression: '1+1' });

      expect(acc.hasScope('tool:search')).toBe(true);
      expect(acc.hasScope('tool:calculator')).toBe(true);
      expect(acc.getBreakdown().byCapability['tool:search']).toBeDefined();
      expect(acc.getBreakdown().byCapability['tool:calculator']).toBeDefined();
    });
  });

  it('no accumulator active: tool executes normally without error', async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'ping',
        description: 'Ping',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      }),
    );

    await expect(registry.execute('ping', {})).resolves.toEqual({
      success: true,
      output: { ok: true },
    });
  });

  it("tool name with special chars: scoped correctly (e.g. 'tool:my-tool')", async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'my-tool',
        description: 'Hyphenated tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      }),
    );

    await withTokenAccounting('run-special', async (acc) => {
      await registry.execute('my-tool', {});
      expect(acc.hasScope('tool:my-tool')).toBe(true);
      expect(acc.getBreakdown().byCapability['tool:my-tool']?.capability).toBe('tool:my-tool');
    });
  });
});

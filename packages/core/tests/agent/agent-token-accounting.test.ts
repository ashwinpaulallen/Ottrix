import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import { runWith } from '../../src/context/run-context.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';
import { CAPABILITY } from '../../src/observability/token-accounting/types.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe('Agent token accounting', () => {
  it('AgentResult.tokenBreakdown is present after run()', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Paris is the capital of France.', usage),
    );
    const agent = new Agent({ name: 'tokens', provider });

    const result = await agent.run('What is the capital of France?');

    expect(result.tokenBreakdown).toBeDefined();
    expect(result.tokenBreakdown!.totalCalls).toBeGreaterThan(0);
  });

  it('tokenBreakdown.runId matches the run\'s runId', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Paris is the capital of France.', usage),
    );
    const agent = new Agent({ name: 'tokens', provider });

    const result = await runWith({ runId: 'run-abc-123' }, () =>
      agent.run('What is the capital of France?'),
    );

    expect(result.tokenBreakdown?.runId).toBe('run-abc-123');
  });

  it("tokenBreakdown.byCapability['_llm'] has the main LLM call tokens", async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Paris is the capital of France.', usage),
    );
    const agent = new Agent({ name: 'tokens', provider });

    const result = await agent.run('What is the capital of France?');
    const llm = result.tokenBreakdown!.byCapability[CAPABILITY.LLM];

    expect(llm).toBeDefined();
    expect(llm!.inputTokens).toBe(10);
    expect(llm!.outputTokens).toBe(5);
    expect(llm!.calls).toBe(1);
  });

  it('tokenBreakdown.totalTokens matches sum of all capabilities', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Paris is the capital of France.', usage),
    );
    const agent = new Agent({ name: 'tokens', provider });

    const result = await agent.run('What is the capital of France?');
    const breakdown = result.tokenBreakdown!;
    const capabilitySum = Object.values(breakdown.byCapability).reduce(
      (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
      0,
    );

    expect(breakdown.totalTokens).toBe(capabilitySum);
    expect(breakdown.totalTokens).toBe(15);
  });

  it("stream() also produces tokenBreakdown on the 'done' event", async () => {
    const provider = new MockCompletionProvider().enqueueStream(
      textCompletion('Streaming Paris answer.', usage),
    );
    const agent = new Agent({ name: 'tokens', provider });

    let doneBreakdown: unknown;
    for await (const event of agent.stream('What is the capital of France?')) {
      if (event.type === 'done') {
        doneBreakdown = (event.data as { tokenBreakdown?: unknown }).tokenBreakdown;
      }
    }

    expect(doneBreakdown).toBeDefined();
    expect((doneBreakdown as { byCapability: Record<string, unknown> }).byCapability[
      CAPABILITY.LLM
    ]).toBeDefined();
  });

  it('multiple tool calls: each tool has its own capability entry', async () => {
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

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [
            { id: 'tu_1', name: 'search', input: { q: 'paris' } },
            { id: 'tu_2', name: 'calculator', input: { expression: '40+2' } },
          ],
          usage,
        ),
      )
      .enqueue(textCompletion('Search and calc done.', usage));

    const agent = new Agent({
      name: 'tokens',
      provider,
      toolRegistry: registry,
    });

    const result = await agent.run('Search and calculate');
    const byCapability = result.tokenBreakdown!.byCapability;

    expect(byCapability['tool:search']).toBeDefined();
    expect(byCapability['tool:calculator']).toBeDefined();
    expect(byCapability[CAPABILITY.LLM]).toBeDefined();
    expect(byCapability[CAPABILITY.LLM]!.calls).toBe(2);
  });

  it('attaches token breakdown attributes to the agent.run span', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('Paris is the capital of France.', usage),
    );
    const agent = new Agent({ name: 'tokens', provider, telemetry });

    await agent.run('What is the capital of France?');

    const runSpan = exporter.spans.find((span) => span.name === 'agent.run');
    expect(runSpan).toBeDefined();
    expect(runSpan!.attributes['ottrix.tokens.total']).toBe(15);
    expect(runSpan!.attributes['ottrix.tokens.input']).toBe(10);
    expect(runSpan!.attributes['ottrix.tokens.output']).toBe(5);
    expect(runSpan!.attributes['ottrix.tokens.by._llm.total']).toBe(15);
    expect(runSpan!.attributes['ottrix.tokens.by._llm.calls']).toBe(1);
  });
});

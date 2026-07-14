import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { AgentEvent } from '../../src/types/agent.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const lightUsage: TokenUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

function createRegistry(tools: FunctionTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

function evalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sufficient: true,
    confidence: 0.95,
    reason: 'Fully answers the question',
    suggestedAction: 'finalize',
    ...overrides,
  });
}

const substantiveAnswer =
  'The capital of France is Paris. It has been the political and cultural center for centuries.';

describe('Agent self-evaluation integration', () => {
  it('evaluation disabled → no evaluator created, no evaluation events', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(substantiveAnswer, lightUsage),
    );
    const events: AgentEvent[] = [];

    const agent = new Agent({
      name: 'test',
      provider,
      onAgentEvent: (e) => events.push(e),
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.response).toBe(substantiveAnswer);
    expect(result.evaluations).toBeUndefined();
    expect(result.refinementsUsed).toBeUndefined();
    expect(events.some((e) => e.type.startsWith('evaluation'))).toBe(false);
    expect(provider.completeCalls).toBe(1);
  });

  it('evaluation enabled, sufficient → no refinement, evaluations in result', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true, threshold: 0.8 },
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.response).toBe(substantiveAnswer);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations![0]!.result.sufficient).toBe(true);
    expect(result.refinementsUsed).toBe(0);
    expect(provider.completeCalls).toBe(2); // answer + LLM eval
  });

  it('evaluation enabled, insufficient → refinement message injected, loop continues', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Missing historical context',
            missingAspects: ['historical context'],
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(
        textCompletion(
          `${substantiveAnswer} Historically it grew from a Roman settlement.`,
          lightUsage,
        ),
      )
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 2 },
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.refinementsUsed).toBe(1);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations![0]!.result.sufficient).toBe(false);
    expect(result.evaluations![1]!.result.sufficient).toBe(true);
    expect(result.response).toContain('Historically');
    expect(provider.completeCalls).toBe(4);
  });

  it('maxRefinements reached → max_refinements_reached event, returns current response', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Still incomplete',
            suggestedAction: 'refine_response',
            missingAspects: ['more detail'],
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Still a short attempt at answering France capital.', lightUsage));
    // No second eval — maxRefinements: 1 means after one refine we stop evaluating

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 1 },
      onAgentEvent: (e) => events.push(e),
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.refinementsUsed).toBe(1);
    expect(events.some((e) => e.type === 'max_refinements_reached')).toBe(true);
    expect(result.response).toContain('France');
  });

  it('skipIfNoTools: true, no tools → evaluation_skipped event', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockCompletionProvider().enqueue(
      textCompletion(substantiveAnswer, lightUsage),
    );

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true, skipIfNoTools: true },
      onAgentEvent: (e) => events.push(e),
    });

    const result = await agent.run('What is the capital of France?');

    expect(events.some((e) => e.type === 'evaluation_skipped')).toBe(true);
    expect(result.evaluations).toBeUndefined();
    expect(provider.completeCalls).toBe(1); // no LLM eval call
  });

  it('refinementCount increments correctly', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Need more',
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion(`${substantiveAnswer} More detail here.`, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Still need more',
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion(`${substantiveAnswer} Even more detail.`, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true, maxRefinements: 3 },
    });

    const result = await agent.run('Explain Paris in detail please.');

    expect(result.refinementsUsed).toBe(2);
    expect(result.evaluations).toHaveLength(3);
    expect(result.evaluations!.map((e) => e.iteration)).toEqual([0, 1, 2]);
  });

  it('EvaluationRecord appears in AgentResult.evaluations', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson({ confidence: 0.88 }), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true },
    });

    const result = await agent.run('What is the capital of France?');
    const record = result.evaluations![0]!;

    expect(record.iteration).toBe(0);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.evaluatedAt).toBeGreaterThan(0);
    expect(record.result.confidence).toBe(0.88);
    expect(result.steps.find((s) => s.type === 'response')?.evaluation).toEqual(record);
  });

  it('refinement messages appear in conversation history', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Missing examples',
            missingAspects: ['examples'],
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion(`${substantiveAnswer} For example, the Louvre.`, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true },
    });

    await agent.run('What is the capital of France?');

    // Second agent completion should see the refinement user message in params
    const secondAnswerParams = provider.lastCompleteParams;
    // After full run, lastCompleteParams is the final eval call. Inspect call history via messages
    // by replaying: the refined answer call is completeCalls index — check via a spy.
    expect(provider.completeCalls).toBe(4);

    // Capture messages from the refined answer call (3rd complete = index 2 after answer, eval, answer)
    const provider2 = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Missing examples',
            missingAspects: ['examples'],
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion(`${substantiveAnswer} For example, the Louvre.`, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const captured: unknown[] = [];
    const originalComplete = provider2.complete.bind(provider2);
    provider2.complete = async (params) => {
      captured.push(params.messages);
      return originalComplete(params);
    };

    const agent2 = new Agent({
      name: 'test',
      provider: provider2,
      evaluation: { enabled: true },
    });
    await agent2.run('What is the capital of France?');

    // 3rd call (index 2) is the refined answer — should include refinement user message
    const refinedMessages = captured[2] as Array<{ role: string; content: unknown }>;
    const refinementMsg = refinedMessages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('needs improvement'),
    );
    expect(refinementMsg).toBeDefined();
    expect(String(refinementMsg!.content)).toContain('examples');
    expect(secondAnswerParams).toBeDefined();
  });

  it('evaluation events emitted in correct order', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Incomplete',
            missingAspects: ['detail'],
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion(`${substantiveAnswer} Extra detail.`, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true },
      onAgentEvent: (e) => events.push(e),
    });

    await agent.run('What is the capital of France?');

    const evalEvents = events.filter((e) =>
      [
        'evaluation_start',
        'evaluation_result',
        'refinement_start',
        'evaluation_skipped',
        'max_refinements_reached',
      ].includes(e.type),
    );

    expect(evalEvents.map((e) => e.type)).toEqual([
      'evaluation_start',
      'evaluation_result',
      'refinement_start',
      'evaluation_start',
      'evaluation_result',
    ]);
  });

  it('streaming: evaluation events appear in stream() output', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'test',
      provider,
      evaluation: { enabled: true },
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('What is the capital of France?')) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'evaluation_start')).toBe(true);
    expect(events.some((e) => e.type === 'evaluation_result')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('tool calls are not evaluated (evaluation only runs on text-only responses)', async () => {
    const search = new FunctionTool({
      name: 'search',
      description: 'Search',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
      execute: async () => ({ result: 'Paris' }),
    });

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([{ id: 'tu_1', name: 'search', input: { q: 'capital' } }], lightUsage),
      )
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const events: AgentEvent[] = [];
    const agent = new Agent({
      name: 'test',
      provider,
      toolRegistry: createRegistry([search]),
      evaluation: { enabled: true },
      onAgentEvent: (e) => events.push(e),
    });

    const result = await agent.run('What is the capital of France?');

    // Only one evaluation_start (after final text), not after tool call
    expect(events.filter((e) => e.type === 'evaluation_start')).toHaveLength(1);
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(1);
    expect(result.evaluations).toHaveLength(1);
  });

  it('maxSteps guard still works during refinement (does not get bypassed)', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Need refine',
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      );
    // maxSteps: 1 → after first text+eval+refine, loop cannot continue

    const agent = new Agent({
      name: 'test',
      provider,
      maxSteps: 1,
      evaluation: { enabled: true, maxRefinements: 5 },
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.metadata.stopReason).toBe('max_steps');
    expect(result.refinementsUsed).toBe(1);
    expect(
      result.evaluations?.some((e) =>
        e.result.reason.includes('maxSteps reached during refinement'),
      ),
    ).toBe(true);
    // Should not have made another answer completion after refine
    expect(provider.completeCalls).toBe(2); // answer + eval only
  });
});

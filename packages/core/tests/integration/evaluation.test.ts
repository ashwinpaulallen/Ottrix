import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import { SufficiencyResultSchema } from '../../src/agent/evaluation/types.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { AgentEvent } from '../../src/types/agent.js';
import type { CompletionParams, TokenUsage } from '../../src/types/provider.js';
import { MockProvider, lightUsage, textCompletion } from '../helpers/mock-provider.js';

const usage: TokenUsage = lightUsage;

const substantiveAnswer =
  'The capital of France is Paris. It has been the political and cultural center for centuries.';

function evalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sufficient: true,
    confidence: 0.9,
    reason: 'Fully answers the question',
    suggestedAction: 'finalize',
    ...overrides,
  });
}

function createSearchRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    new FunctionTool({
      name: 'search',
      description: 'Search the web',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
      execute: async () => ({ results: [] }),
    }),
  );
  return registry;
}

describe('integration: self-evaluation', () => {
  it('no evaluation (baseline) — one pass, no evaluation events', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider().enqueue(textCompletion(substantiveAnswer, usage));

    const agent = new Agent({
      name: 'baseline',
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

  it('sufficient on first attempt — no refinement', async () => {
    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(evalJson({ confidence: 0.9 }), usage));

    const agent = new Agent({
      name: 'eval-sufficient',
      provider,
      evaluation: { enabled: true, threshold: 0.8 },
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.refinementsUsed).toBe(0);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations![0]!.result.sufficient).toBe(true);
    expect(result.evaluations![0]!.result.confidence).toBe(0.9);
    expect(provider.completeCalls).toBe(2);
  });

  it('insufficient then sufficient — one refinement', async () => {
    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.85,
            reason: 'Should use a tool for live data',
            missingAspects: ['tool-backed facts'],
            suggestedAction: 'use_tool',
          }),
          usage,
        ),
      )
      .enqueue(
        textCompletion(
          `${substantiveAnswer} Verified via search: Paris remains the capital.`,
          usage,
        ),
      )
      .enqueue(textCompletion(evalJson({ confidence: 0.92 }), usage));

    const agent = new Agent({
      name: 'eval-refine',
      provider,
      toolRegistry: createSearchRegistry(),
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 2 },
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.refinementsUsed).toBe(1);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations![0]!.result.sufficient).toBe(false);
    expect(result.evaluations![0]!.result.suggestedAction).toBe('use_tool');
    expect(result.evaluations![1]!.result.sufficient).toBe(true);
    expect(result.evaluations![1]!.result.confidence).toBe(0.92);
  });

  it('always insufficient — hits maxRefinements then stops with a response', async () => {
    const events: AgentEvent[] = [];
    const insufficient = evalJson({
      sufficient: false,
      confidence: 0.9,
      reason: 'Still incomplete',
      missingAspects: ['more detail'],
      suggestedAction: 'refine_response',
    });

    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(insufficient, usage))
      .enqueue(textCompletion('Paris is the capital, attempt two with more detail.', usage))
      .enqueue(textCompletion(insufficient, usage))
      .enqueue(textCompletion('Paris is the capital, final attempt after refinements.', usage));

    const agent = new Agent({
      name: 'eval-max-refine',
      provider,
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 2 },
      onAgentEvent: (e) => events.push(e),
    });

    const result = await agent.run('What is the capital of France?');

    expect(events.some((e) => e.type === 'max_refinements_reached')).toBe(true);
    expect(result.refinementsUsed).toBe(2);
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.response).toContain('Paris');
  });

  it('heuristic fast-path — no LLM eval call for obvious hedging', async () => {
    const provider = new MockProvider()
      .enqueue(textCompletion("I'll look that up for you.", usage))
      .enqueue(
        textCompletion(`${substantiveAnswer} Looked up via search as requested.`, usage),
      )
      .enqueue(textCompletion(evalJson(), usage));

    const agent = new Agent({
      name: 'eval-heuristic',
      provider,
      toolRegistry: createSearchRegistry(),
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 2 },
    });

    const result = await agent.run('What is the capital of France?');

    // 2 agent answers + 1 LLM eval (only after the refined response)
    expect(provider.completeCalls).toBe(3);
    expect(result.refinementsUsed).toBe(1);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations![0]!.result.sufficient).toBe(false);
    expect(result.evaluations![0]!.result.suggestedAction).toBe('use_tool');
    expect(result.evaluations![0]!.tokenUsage).toBeUndefined();
  });

  it('streaming — evaluation events appear in order relative to text', async () => {
    const provider = new MockProvider()
      .enqueueStream(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(evalJson({ confidence: 0.91 }), usage));

    const agent = new Agent({
      name: 'eval-stream',
      provider,
      evaluation: { enabled: true },
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('What is the capital of France?')) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    const textIdx = types.indexOf('text');
    const evalStartIdx = types.indexOf('evaluation_start');
    const evalResultIdx = types.indexOf('evaluation_result');
    const doneIdx = types.indexOf('done');

    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(evalStartIdx).toBeGreaterThan(textIdx);
    expect(evalResultIdx).toBeGreaterThan(evalStartIdx);
    expect(doneIdx).toBeGreaterThan(evalResultIdx);
  });

  it('maxSteps guard during refinement — does not exceed maxSteps', async () => {
    const insufficient = evalJson({
      sufficient: false,
      confidence: 0.9,
      reason: 'Need refine',
      suggestedAction: 'refine_response',
      missingAspects: ['detail'],
    });

    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(insufficient, usage))
      .enqueue(textCompletion('Refined answer pass two about Paris.', usage))
      .enqueue(textCompletion(insufficient, usage))
      .enqueue(textCompletion('Refined answer pass three about Paris.', usage))
      .enqueue(textCompletion(insufficient, usage));

    const agent = new Agent({
      name: 'eval-max-steps',
      provider,
      maxSteps: 3,
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 5 },
    });

    const result = await agent.run('What is the capital of France?');

    expect(result.metadata.stopReason).toBe('max_steps');
    const responseSteps = result.steps.filter((s) => s.type === 'response');
    expect(responseSteps.length).toBeLessThanOrEqual(3);
    expect(result.refinementsUsed ?? 0).toBeLessThanOrEqual(3);
    expect(result.response.length).toBeGreaterThan(0);
  });

  it('custom criteria appear in the LLM evaluator system prompt', async () => {
    const captured: CompletionParams[] = [];
    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(evalJson(), usage));

    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (params) => {
      captured.push(params);
      return originalComplete(params);
    };

    const agent = new Agent({
      name: 'eval-criteria',
      provider,
      evaluation: {
        enabled: true,
        criteria: ['Always respond in French'],
      },
    });

    await agent.run('What is the capital of France?');

    expect(captured).toHaveLength(2);
    expect(captured[1]!.systemPrompt).toContain('Always respond in French');
  });

  it('cheap evaluation model is used for eval calls only', async () => {
    const models: Array<string | undefined> = [];
    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(evalJson(), usage));

    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (params) => {
      models.push(params.model);
      return originalComplete(params);
    };

    const agent = new Agent({
      name: 'eval-cheap-model',
      provider,
      defaultModel: 'claude-sonnet-4',
      evaluation: {
        enabled: true,
        model: 'claude-haiku-3.5',
      },
    });

    await agent.run('What is the capital of France?');

    expect(models).toEqual(['claude-sonnet-4', 'claude-haiku-3.5']);
  });

  it('EvaluationRecord fields match schema', async () => {
    const provider = new MockProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(
        textCompletion(
          evalJson({
            confidence: 0.88,
            reason: 'Complete and accurate',
          }),
          usage,
        ),
      );

    const agent = new Agent({
      name: 'eval-record',
      provider,
      evaluation: { enabled: true },
    });

    const result = await agent.run('What is the capital of France?');
    const record = result.evaluations![0]!;

    expect(record.iteration).toBe(0);
    expect(record.evaluatedAt).toEqual(expect.any(Number));
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.result).toBeDefined();

    const parsed = SufficiencyResultSchema.safeParse(record.result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.confidence).toBe(0.88);
  });
});

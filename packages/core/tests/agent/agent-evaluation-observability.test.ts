import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import {
  AuditEmitter,
  InMemorySink,
  resetAudit,
  useAudit,
} from '../../src/guardrails/audit.js';
import {
  getMetricsCollector,
  resetGlobalObservability,
  setMetricsCollector,
} from '../../src/observability/global.js';
import { MetricsCollector } from '../../src/observability/metrics.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';
import type { TokenUsage } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
} from '../fixtures/mock-provider.js';

const lightUsage: TokenUsage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };

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

describe('Agent evaluation observability', () => {
  let metrics: MetricsCollector;
  let sink: InMemorySink;

  beforeEach(() => {
    resetGlobalObservability();
    resetAudit();
    metrics = new MetricsCollector();
    setMetricsCollector(metrics);
    sink = new InMemorySink();
    useAudit(new AuditEmitter({ sink }));
  });

  afterEach(() => {
    resetAudit();
    resetGlobalObservability();
  });

  it('evaluation creates child span with correct attributes', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'eval-obs',
      provider,
      telemetry,
      evaluation: { enabled: true, threshold: 0.8 },
    });

    await agent.run('What is the capital of France?');

    const evalSpan = exporter.spans.find((s) => s.name === 'ottrix.agent.evaluation');
    const rootSpan = exporter.spans.find((s) => s.name === 'agent.run');

    expect(evalSpan).toBeDefined();
    expect(rootSpan).toBeDefined();
    expect(evalSpan!.parentSpanId).toBe(rootSpan!.spanId);
    expect(evalSpan!.attributes['ottrix.evaluation.refinement_number']).toBe(0);
    expect(evalSpan!.attributes['ottrix.evaluation.sufficient']).toBe(true);
    expect(evalSpan!.attributes['ottrix.evaluation.confidence']).toBe(0.95);
    expect(evalSpan!.attributes['ottrix.evaluation.suggested_action']).toBe('finalize');
    expect(evalSpan!.attributes['ottrix.evaluation.missing_aspects_count']).toBe(0);
    expect(evalSpan!.attributes['ottrix.evaluation.duration_ms']).toEqual(expect.any(Number));
    expect(evalSpan!.attributes['ottrix.evaluation.model']).toBe('mock-model');
    expect(evalSpan!.attributes['gen_ai.usage.input_tokens']).toBe(1000);
    expect(evalSpan!.attributes['gen_ai.usage.output_tokens']).toBe(500);
  });

  it('parent span gets refinement count and evaluation summary attributes', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
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
      name: 'eval-obs',
      provider,
      telemetry,
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 2 },
    });

    await agent.run('What is the capital of France?');

    const rootSpan = exporter.spans.find((s) => s.name === 'agent.run');
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.attributes['ottrix.evaluation.enabled']).toBe(true);
    expect(rootSpan!.attributes['ottrix.evaluation.refinements_triggered']).toBe(1);
    expect(rootSpan!.attributes['ottrix.evaluation.final_sufficient']).toBe(true);
    // 2 eval calls × (1000/1000*0.003 + 500/1000*0.015) = 2 × 0.0105
    expect(rootSpan!.attributes['ottrix.evaluation.total_cost_usd']).toBeCloseTo(0.021, 6);
  });

  it('MetricsCollector increments evaluation_triggered_total', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'eval-obs',
      provider,
      evaluation: { enabled: true, threshold: 0.8 },
    });

    await agent.run('What is the capital of France?');

    const stats = getMetricsCollector().getStats('evaluation_triggered_total', {
      agent: 'eval-obs',
    });
    expect(stats.count).toBe(1);
    expect(stats.max).toBe(1);

    const duration = getMetricsCollector().getStats('evaluation_duration_ms', {
      agent: 'eval-obs',
    });
    expect(duration.count).toBe(1);

    const confidence = getMetricsCollector().getStats('evaluation_confidence', {
      agent: 'eval-obs',
    });
    expect(confidence.count).toBe(1);
    expect(confidence.mean).toBe(0.95);
  });

  it('MetricsCollector increments refinement_triggered_total when refinement happens', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(
        textCompletion(
          evalJson({
            sufficient: false,
            confidence: 0.9,
            reason: 'Missing detail',
            missingAspects: ['detail'],
            suggestedAction: 'refine_response',
          }),
          lightUsage,
        ),
      )
      .enqueue(textCompletion(`${substantiveAnswer} Extra detail here.`, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'eval-obs',
      provider,
      evaluation: { enabled: true, threshold: 0.8, maxRefinements: 2 },
    });

    await agent.run('What is the capital of France?');

    const triggered = getMetricsCollector().getStats('evaluation_triggered_total', {
      agent: 'eval-obs',
    });
    expect(triggered.count).toBe(2);

    const refinements = getMetricsCollector().getStats(
      'evaluation_refinement_triggered_total',
      { agent: 'eval-obs' },
    );
    expect(refinements.count).toBe(1);
    expect(refinements.max).toBe(1);

    const cost = getMetricsCollector().getStats('evaluation_cost_usd', {
      agent: 'eval-obs',
    });
    expect(cost.count).toBe(2);
    expect(cost.mean).toBeCloseTo(0.0105, 6);
  });

  it('AuditEmitter receives evaluation event without response text', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, lightUsage))
      .enqueue(textCompletion(evalJson(), lightUsage));

    const agent = new Agent({
      name: 'eval-obs',
      provider,
      evaluation: { enabled: true, threshold: 0.8 },
    });

    await agent.run('What is the capital of France?');

    const evalEvents = sink.getEvents().filter((e) => e.type === 'agent.evaluation.run');
    expect(evalEvents).toHaveLength(1);

    const event = evalEvents[0]!;
    expect(event.payload).toEqual({
      refinement: 0,
      sufficient: true,
      confidence: 0.95,
      suggestedAction: 'finalize',
    });
    expect(JSON.stringify(event.payload)).not.toContain(substantiveAnswer);
    expect(JSON.stringify(event.payload)).not.toContain('Fully answers');
  });
});

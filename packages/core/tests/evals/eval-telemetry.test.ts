import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import { getRunContext, type RunContext } from '../../src/context/run-context.js';
import { EvalRunner } from '../../src/evals/runner.js';
import { ExactMatchScorer, type Scorer } from '../../src/evals/scorers.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

const verboseScorer: Scorer = {
  name: 'verbose',
  score() {
    return Promise.resolve({ score: 0.25, reason: 'x'.repeat(250) });
  },
};

describe('EvalRunner telemetry correlation', () => {
  it('sets evalRunId on the report', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('Paris'));
    const agent = new Agent({ name: 'eval-agent', provider });
    const runner = new EvalRunner({
      agent,
      dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
      scorers: [new ExactMatchScorer()],
    });

    const report = await runner.run();

    expect(report.evalRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('assigns a unique runId to each eval result', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion('Paris'))
      .enqueue(textCompletion('Berlin'));
    const agent = new Agent({ name: 'eval-agent', provider });
    const runner = new EvalRunner({
      agent,
      dataset: [
        { input: 'Capital of France?', expectedOutput: 'Paris' },
        { input: 'Capital of Germany?', expectedOutput: 'Berlin' },
      ],
      scorers: [new ExactMatchScorer()],
      concurrency: 2,
    });

    const report = await runner.run();
    const runIds = report.results.map((result) => result.runId);

    expect(runIds).toEqual([`${report.evalRunId}-0`, `${report.evalRunId}-1`]);
    expect(new Set(runIds).size).toBe(2);
  });

  it('sets RunContext with evalRunId while the eval case runs', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('Paris'));
    const seen: Array<RunContext | undefined> = [];
    const original = provider.complete.bind(provider);
    provider.complete = async (params) => {
      seen.push(getRunContext());
      return original(params);
    };

    const agent = new Agent({ name: 'eval-agent', provider });
    const input = 'Capital of France? '.repeat(6);
    const runner = new EvalRunner({
      agent,
      dataset: [{ input, expectedOutput: 'Paris' }],
      scorers: [new ExactMatchScorer()],
    });

    const report = await runner.run();
    const ctx = seen[0];

    expect(ctx?.evalRunId).toBe(report.evalRunId);
    expect(ctx?.runId).toBe(report.results[0]?.runId);
    expect(ctx?.evalCase).toBe(input.slice(0, 50));
  });

  it('adds ottrix.eval.run_id to the agent run span', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const provider = new MockCompletionProvider().enqueue(textCompletion('Paris'));
    const agent = new Agent({ name: 'eval-agent', provider, telemetry });
    const runner = new EvalRunner({
      agent,
      dataset: [
        { input: 'Capital of France?', expectedOutput: 'Paris' },
        { input: 'Capital of Germany?', expectedOutput: 'Berlin' },
      ],
      scorers: [new ExactMatchScorer()],
      concurrency: 1,
    });

    provider.enqueue(textCompletion('Berlin'));
    const report = await runner.run();
    const agentSpans = exporter.spans.filter((span) => span.name === 'agent.run');

    expect(agentSpans).toHaveLength(2);
    expect(agentSpans[0]?.attributes['ottrix.eval.run_id']).toBe(report.evalRunId);
    expect(agentSpans[0]?.attributes['ottrix.eval.case_id']).toBe(`${report.evalRunId}-0`);
    expect(agentSpans[0]?.attributes['ottrix.eval.case_index']).toBe(0);
    expect(agentSpans[0]?.attributes['ottrix.eval.dataset_size']).toBe(2);
    expect(agentSpans[0]?.attributes['ottrix.eval.case']).toBe('Capital of France?');
    expect(report.results[0]?.traceId).toBe(agentSpans[0]?.traceId);
    expect(report.results[0]?.runId).toBe(`${report.evalRunId}-0`);
  });

  it('records each scorer result as an eval.score span event', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const provider = new MockCompletionProvider().enqueue(textCompletion('Paris'));
    const agent = new Agent({ name: 'eval-agent', provider, telemetry });
    const runner = new EvalRunner({
      agent,
      dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
      scorers: [new ExactMatchScorer(), verboseScorer],
    });

    await runner.run();

    const scoreEvents = exporter.spans.flatMap((span) =>
      span.events.filter((event) => event.name === 'eval.score'),
    );

    const exact = scoreEvents.find((event) => event.attributes?.scorer === 'exact_match');
    const verbose = scoreEvents.find((event) => event.attributes?.scorer === 'verbose');

    expect(exact).toMatchObject({
      name: 'eval.score',
      attributes: {
        scorer: 'exact_match',
        score: 1,
        reason: 'Exact match',
      },
    });
    expect(verbose).toMatchObject({
      name: 'eval.score',
      attributes: {
        scorer: 'verbose',
        score: 0.25,
        reason: 'x'.repeat(200),
      },
    });
  });
});

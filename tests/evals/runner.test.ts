import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { EvalRunner } from '../../src/evals/runner.js';
import { ContainsScorer, ExactMatchScorer } from '../../src/evals/scorers.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

describe('EvalRunner', () => {
  it('runs five entries with two scorers and aggregates correctly', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion('Paris'))
      .enqueue(textCompletion('wrong'))
      .enqueue(textCompletion('The capital is Paris and France is in Europe.'))
      .enqueue(textCompletion('Berlin'))
      .enqueue(textCompletion('Paris is the capital of France.'));

    const agent = new Agent({ name: 'eval-agent', provider });
    const dataset = [
      { input: 'Capital of France?', expectedOutput: 'Paris', tags: ['geo'] },
      { input: 'Capital of France?', expectedOutput: 'Paris' },
      {
        input: 'Describe France',
        expectedOutput: 'Paris',
        metadata: { keywords: ['Paris', 'France', 'Europe'] },
      },
      { input: 'Capital of Germany?', expectedOutput: 'Berlin' },
      { input: 'Capital of France?', expectedOutput: 'Paris' },
    ];

    const runner = new EvalRunner({
      agent,
      dataset,
      scorers: [
        new ExactMatchScorer(),
        new ContainsScorer(['Paris', 'France']),
      ],
      concurrency: 2,
      name: 'france-capital-eval',
    });

    const report = await runner.run();

    expect(report.results).toHaveLength(5);
    expect(report.config.scorerNames).toEqual(['exact_match', 'contains(Paris,France)']);
    expect(report.aggregates.exact_match?.count).toBe(5);
    expect(report.aggregates.exact_match?.mean).toBeCloseTo(0.4);
    expect(report.aggregates['contains(Paris,France)']?.count).toBe(5);
    expect(report.results[0]?.scores.exact_match?.score).toBe(1);
    expect(report.results[1]?.scores.exact_match?.score).toBe(0);
  });

  it('handles agent errors gracefully with score 0 and captured error', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('ok'));
    const agent = new Agent({ name: 'fail-agent', provider });

    const dataset = [
      { input: 'first', expectedOutput: 'ok' },
      { input: 'second', expectedOutput: 'ok' },
    ];

    const runner = new EvalRunner({
      agent,
      dataset,
      scorers: [new ExactMatchScorer()],
      concurrency: 1,
    });

    const report = await runner.run();

    expect(report.results[0]?.error).toBeUndefined();
    expect(report.results[0]?.scores.exact_match?.score).toBe(1);
    expect(report.results[1]?.error).toMatch(/no more complete/i);
    expect(report.results[1]?.scores.exact_match?.score).toBe(0);
    expect(report.aggregates.exact_match?.mean).toBeCloseTo(0.5);
  });
});

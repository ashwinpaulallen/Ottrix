import { describe, expect, it, vi } from 'vitest';
import { csvEscape, escapeMarkdown, EvalReporter } from '../../src/evals/reporter.js';
import type { EvalReport } from '../../src/evals/types.js';

function sampleReport(): EvalReport {
  return {
    name: 'sample-eval',
    timestamp: 1_700_000_000_000,
    duration: 120,
    config: {
      name: 'sample-eval',
      agentName: 'test-agent',
      concurrency: 1,
      scorerNames: ['exact_match'],
      datasetSize: 1,
    },
    aggregates: {
      exact_match: {
        mean: 1,
        median: 1,
        min: 1,
        max: 1,
        stdDev: 0,
        count: 1,
        histogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      },
    },
    results: [
      {
        entry: { input: 'hello', expectedOutput: 'world' },
        agentOutput: {
          response: 'world',
          steps: [],
          totalTokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          metadata: { stopReason: 'completed' },
        },
        scores: { exact_match: { score: 1, reason: 'Exact match' } },
        duration: 10,
      },
    ],
  };
}

describe('EvalReporter', () => {
  it('toConsole prints without throwing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reporter = new EvalReporter();

    expect(() => reporter.toConsole(sampleReport())).not.toThrow();
    expect(logSpy).toHaveBeenCalledOnce();

    logSpy.mockRestore();
  });

  it('toJson produces valid JSON', () => {
    const reporter = new EvalReporter();
    const json = reporter.toJson(sampleReport());

    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).name).toBe('sample-eval');
  });

  it('toMarkdown escapes table-breaking characters', () => {
    const reporter = new EvalReporter();
    const report = sampleReport();
    report.name = 'eval|name';
    report.results[0]!.entry.input = 'value|with|pipes';

    const markdown = reporter.toMarkdown(report);
    expect(markdown).toContain('eval\\|name');
    expect(markdown).toContain('value\\|with\\|pipes');
  });

  it('toCsv escapes formula injection and quotes', () => {
    const reporter = new EvalReporter();
    const report = sampleReport();
    report.results[0]!.entry.input = '=1+1';
    report.results[0]!.agentOutput.response = 'he said "hello"';

    const csv = reporter.toCsv(report);
    expect(csv).toContain('"=1+1"');
    expect(csv).toContain('"he said ""hello"""');
  });
});

describe('reporter escape helpers', () => {
  it('csvEscape wraps formula-like values', () => {
    expect(csvEscape('-10')).toBe('"-10"');
    expect(csvEscape('+cmd')).toBe('"+cmd"');
  });

  it('escapeMarkdown escapes markdown control characters', () => {
    expect(escapeMarkdown('a|b')).toBe('a\\|b');
    expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
  });
});

import { describe, expect, it } from 'vitest';
import { RunRecorder } from '../../src/observability/replay.js';
import type { AgentResult } from '../../src/types/agent.js';
import type { SpanData } from '../../src/observability/telemetry.js';

describe('RunRecorder', () => {
  it('rejects overlapping startRun calls', () => {
    const recorder = new RunRecorder();
    recorder.startRun('one');
    expect(() => recorder.startRun('two')).toThrow(/already active/);
    recorder.cancelRun();
    expect(() => recorder.startRun('two')).not.toThrow();
  });

  it('sorts replay timeline with epoch span timestamps', () => {
    const startedAt = new Date('2024-01-01T00:00:00.000Z').toISOString();
    const endedAt = new Date('2024-01-01T00:00:00.200Z').toISOString();
    const mid = Date.parse(startedAt) + 50;

    const recorder = RunRecorder.fromJSON(
      JSON.stringify([
        {
          id: 'run-1',
          agentName: 'sort-agent',
          input: 'hello',
          response: 'ok',
          startedAt,
          endedAt,
          durationMs: 200,
          steps: [{ type: 'response', content: { text: 'ok' }, timestamp: mid + 5 }],
          spans: [
            {
              traceId: 't',
              spanId: 's',
              name: 'llm.complete',
              startTime: mid,
              endTime: mid + 10,
              durationMs: 10,
              attributes: {},
              events: [],
              status: 'ok',
            },
          ],
        },
      ]),
    );

    const labels = [...recorder.replay('run-1')].map((s) => s.label);
    expect(labels[0]).toBe('user.input');
    expect(labels[labels.length - 1]).toBe('agent.response');
    expect(labels.indexOf('llm.complete')).toBeLessThan(labels.indexOf('agent.response'));
  });

  it('serializes and replays a recorded run', () => {
    const recorder = new RunRecorder({ agentName: 'test-agent' });
    recorder.startRun('hello');

    const span: SpanData = {
      traceId: 'trace-1',
      spanId: 'span-1',
      name: 'agent.run',
      startTime: 100,
      endTime: 150,
      durationMs: 50,
      attributes: {},
      events: [],
      status: 'ok',
    };
    recorder.recordSpan(span);

    const result: AgentResult = {
      response: 'world',
      steps: [{ type: 'response', content: { text: 'world' }, timestamp: Date.now() }],
      totalTokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metadata: { stopReason: 'completed' },
    };

    const run = recorder.endRun(result);
    const json = recorder.toJSON();
    const restored = RunRecorder.fromJSON(json);

    expect(run.response).toBe('world');
    expect(restored.getRuns()).toHaveLength(1);

    const steps = [...restored.replay(run.id)];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.label === 'agent.run')).toBe(true);
    expect(steps.some((s) => s.label === 'agent.response')).toBe(true);
  });
});

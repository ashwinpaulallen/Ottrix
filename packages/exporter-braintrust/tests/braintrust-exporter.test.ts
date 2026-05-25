import { BraintrustExporter } from '../src/index.js';
import type { TraceData } from 'ottrix';
import { describe, expect, it } from 'vitest';

function sampleTrace(overrides: Partial<TraceData> = {}): TraceData {
  const start = Date.now() - 100;
  return {
    traceId: 'trace-1',
    name: 'agent.run',
    startTime: start,
    endTime: start + 100,
    status: 'ok',
    attributes: {},
    spans: [
      {
        spanId: 'span-1',
        parentSpanId: 'trace-1',
        name: 'llm.complete',
        startTime: start + 10,
        endTime: start + 80,
        attributes: { 'llm.model': 'mock' },
        events: [],
      },
    ],
    metadata: {},
    input: 'hello',
    output: 'world',
    ...overrides,
  };
}

describe('@ottrix/exporter-braintrust', () => {
  it('translates trace data to Braintrust events', () => {
    const exporter = new BraintrustExporter({
      apiKey: 'test-key',
      projectName: 'test-project',
      projectId: 'proj-123',
    });

    const events = exporter.translateTrace(sampleTrace());
    expect(events).toHaveLength(2);
    expect(events[0]?.is_root).toBe(true);
    expect(events[1]?.name).toBe('llm.complete');
  });
});

import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../src/observability/metrics.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';

describe('Telemetry retention', () => {
  it('drops oldest finished spans when maxFinishedSpans is exceeded', () => {
    const telemetry = new Telemetry({ retention: { maxFinishedSpans: 2 } });

    telemetry.startSpan('one').end();
    telemetry.startSpan('two').end();
    telemetry.startSpan('three').end();

    expect(telemetry.finishedSpans).toHaveLength(2);
    expect(telemetry.finishedSpans.map((span) => span.name)).toEqual(['two', 'three']);
  });

  it('drops oldest metric points when maxMetricPoints is exceeded', () => {
    const telemetry = new Telemetry({ retention: { maxMetricPoints: 2 } });
    telemetry.counter('hits').add(1);
    telemetry.counter('hits').add(1);
    telemetry.counter('hits').add(1);

    expect(telemetry.metricPoints).toHaveLength(2);
    expect(telemetry.metricPoints[0]?.value).toBe(2);
    expect(telemetry.metricPoints[1]?.value).toBe(3);
  });

  it('caps histogram sample arrays', () => {
    const telemetry = new Telemetry({ retention: { maxHistogramSamples: 2 } });
    const histogram = telemetry.histogram('latency_ms');

    histogram.record(1);
    histogram.record(2);
    histogram.record(3);

    expect(histogram.getValues()).toEqual([2, 3]);
  });
});

describe('Telemetry metrics bridge', () => {
  it('forwards histogram observations to MetricsCollector', () => {
    const collector = new MetricsCollector();
    const telemetry = new Telemetry({ metricsCollector: collector });

    telemetry.histogram('llm.tokens', { kind: 'input' }).record(12);

    expect(collector.getStats('llm.tokens', { kind: 'input' }).count).toBe(1);
    expect(collector.getStats('llm.tokens', { kind: 'input' }).mean).toBe(12);
  });

  it('forwards counter totals to MetricsCollector', () => {
    const collector = new MetricsCollector();
    const telemetry = new Telemetry({ metricsCollector: collector });

    telemetry.counter('llm.calls', { component: 'agent' }).add(1);
    telemetry.counter('llm.calls', { component: 'agent' }).add(1);

    expect(collector.getStats('llm.calls.total', { component: 'agent' }).max).toBe(2);
  });
});

describe('MetricsCollector retention', () => {
  it('drops oldest values when maxValuesPerSeries is exceeded', () => {
    const collector = new MetricsCollector({ maxValuesPerSeries: 2 });
    collector.record('latency_ms', 1);
    collector.record('latency_ms', 2);
    collector.record('latency_ms', 3);

    const stats = collector.getStats('latency_ms');
    expect(stats.count).toBe(2);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(3);
  });
});

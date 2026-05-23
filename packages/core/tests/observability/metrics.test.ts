import { afterEach, describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../src/observability/metrics.js';

describe('MetricsCollector', () => {
  const collector = new MetricsCollector();

  afterEach(() => {
    collector.reset();
  });

  it('returns correct percentile statistics', () => {
    for (let value = 1; value <= 100; value += 1) {
      collector.record('latency_ms', value);
    }

    const stats = collector.getStats('latency_ms');
    expect(stats.count).toBe(100);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBeCloseTo(50.5);
    expect(stats.p50).toBeCloseTo(50.5, 0);
    expect(stats.p95).toBeCloseTo(95.05, 0);
    expect(stats.p99).toBeCloseTo(99.01, 0);
  });

  it('filters series by labels', () => {
    collector.record('ttft_ms', 100, { provider: 'openai' });
    collector.record('ttft_ms', 200, { provider: 'anthropic' });
    collector.record('ttft_ms', 150, { provider: 'openai' });

    expect(collector.getStats('ttft_ms', { provider: 'openai' }).mean).toBe(125);
    expect(collector.getStats('ttft_ms', { provider: 'anthropic' }).mean).toBe(200);
    expect(collector.getAll()['ttft_ms:{"provider":"anthropic"}']?.count).toBe(1);
  });
});

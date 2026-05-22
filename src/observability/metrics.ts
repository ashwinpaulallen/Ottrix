/** Summary statistics for a recorded metric series. */
export interface MetricStats {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

/** Options for {@link MetricsCollector}. */
export interface MetricsCollectorOptions {
  /** Max observations kept per series (oldest dropped). Omit for unbounded. */
  maxValuesPerSeries?: number;
}

/** In-memory metrics collector with percentile statistics. */
export class MetricsCollector {
  private readonly series = new Map<string, number[]>();
  private maxValuesPerSeries?: number;

  constructor(options: MetricsCollectorOptions = {}) {
    this.maxValuesPerSeries = options.maxValuesPerSeries;
  }

  /** Configure retention for all metric series. */
  setRetention(maxValuesPerSeries?: number): void {
    this.maxValuesPerSeries = maxValuesPerSeries;
    if (maxValuesPerSeries === undefined) {
      return;
    }
    for (const [key, values] of this.series.entries()) {
      if (values.length > maxValuesPerSeries) {
        this.series.set(key, values.slice(values.length - maxValuesPerSeries));
      }
    }
  }

  /** Record a numeric observation for a metric (optionally labeled). */
  record(metric: string, value: number, labels?: Record<string, string>): void {
    const key = metricSeriesKey(metric, labels);
    const values = this.series.get(key);
    if (values) {
      values.push(value);
      this.trimSeries(values);
      return;
    }
    const next = [value];
    this.series.set(key, next);
  }

  /** Return summary statistics for a metric series. */
  getStats(metric: string, labels?: Record<string, string>): MetricStats {
    const key = metricSeriesKey(metric, labels);
    return summarizeValues(this.series.get(key) ?? []);
  }

  /** Return stats for every recorded metric series. */
  getAll(): Record<string, MetricStats> {
    const all: Record<string, MetricStats> = {};
    for (const [key, values] of this.series.entries()) {
      all[key] = summarizeValues(values);
    }
    return all;
  }

  /** Clear all recorded observations. */
  reset(): void {
    this.series.clear();
  }

  private trimSeries(values: number[]): void {
    if (this.maxValuesPerSeries === undefined || values.length <= this.maxValuesPerSeries) {
      return;
    }
    values.splice(0, values.length - this.maxValuesPerSeries);
  }
}

function metricSeriesKey(metric: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return metric;
  }

  const sortedEntries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `${metric}:${JSON.stringify(Object.fromEntries(sortedEntries))}`;
}

function summarizeValues(values: number[]): MetricStats {
  const count = values.length;
  if (count === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const min = sorted[0]!;
  const max = sorted[count - 1]!;

  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min,
    max,
    count,
  };
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0]!;
  }

  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower]!;
  }

  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

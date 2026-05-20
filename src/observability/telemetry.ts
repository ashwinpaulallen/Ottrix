import { randomUUID } from 'node:crypto';

/** Attribute value types supported on spans and metrics. */
export type AttributeValue = string | number | boolean;

/** Span status code. */
export type SpanStatusCode = 'ok' | 'error' | 'unset';

/** Serializable finished span. */
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
  status: SpanStatusCode;
  statusMessage?: string;
}

/** Event recorded on a span timeline. */
export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, AttributeValue>;
}

/** Metric data point for export. */
export interface MetricPoint {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  value: number;
  attributes?: Record<string, AttributeValue>;
  timestamp: number;
}

/** Pluggable telemetry exporter (OpenTelemetry-compatible shape). */
export interface TelemetryExporter {
  exportSpan(span: SpanData): void;
  exportMetric?(point: MetricPoint): void;
  shutdown?(): void | Promise<void>;
}

/** Options for {@link Telemetry}. */
export interface TelemetryOptions {
  exporters?: TelemetryExporter[];
}

/**
 * Span-based tracing and metrics (OpenTelemetry-inspired, zero dependency).
 */
export class Telemetry {
  private readonly exporters: TelemetryExporter[];
  private readonly activeStack: Span[] = [];
  private readonly spans: SpanData[] = [];
  private readonly metrics: MetricPoint[] = [];
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, Gauge>();

  constructor(options: TelemetryOptions = {}) {
    this.exporters = options.exporters ?? [];
  }

  /** Currently active span, if any. */
  get activeSpan(): Span | undefined {
    return this.activeStack[this.activeStack.length - 1];
  }

  /** Finished spans collected by this instance. */
  get finishedSpans(): readonly SpanData[] {
    return this.spans;
  }

  /** Exported metric points. */
  get metricPoints(): readonly MetricPoint[] {
    return this.metrics;
  }

  /** Register an exporter. */
  addExporter(exporter: TelemetryExporter): void {
    this.exporters.push(exporter);
  }

  /** Start a new span (child of the active span when present). */
  startSpan(name: string, attributes?: Record<string, AttributeValue>): Span {
    const parent = this.activeSpan;
    return new Span({
      name,
      traceId: parent?.traceId ?? randomUUID(),
      parentSpanId: parent?.spanId,
      attributes: attributes ?? {},
      telemetry: this,
    });
  }

  /** Run `fn` with `span` set as the active span. */
  async withActiveSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T> {
    this.enterActiveSpan(span);
    try {
      return await fn();
    } finally {
      this.leaveActiveSpan();
    }
  }

  /** Push a span onto the active stack (for sync code paths such as streaming). */
  enterActiveSpan(span: Span): void {
    this.activeStack.push(span);
  }

  /** Pop the active span from the stack. */
  leaveActiveSpan(): void {
    this.activeStack.pop();
  }

  /** Finished spans recorded since `startIndex` (for per-run export). */
  getFinishedSpansSince(startIndex: number): readonly SpanData[] {
    return this.spans.slice(startIndex);
  }

  /** Counter metric (monotonically increasing). */
  counter(name: string, attributes?: Record<string, AttributeValue>): Counter {
    const key = metricKey(name, attributes);
    let counter = this.counters.get(key);
    if (!counter) {
      counter = new Counter(name, attributes, this);
      this.counters.set(key, counter);
    }
    return counter;
  }

  /** Histogram metric (distribution of values). */
  histogram(name: string, attributes?: Record<string, AttributeValue>): Histogram {
    const key = metricKey(name, attributes);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = new Histogram(name, attributes, this);
      this.histograms.set(key, histogram);
    }
    return histogram;
  }

  /** Gauge metric (point-in-time value). */
  gauge(name: string, attributes?: Record<string, AttributeValue>): Gauge {
    const key = metricKey(name, attributes);
    let gauge = this.gauges.get(key);
    if (!gauge) {
      gauge = new Gauge(name, attributes, this);
      this.gauges.set(key, gauge);
    }
    return gauge;
  }

  /** @internal */
  recordSpan(span: SpanData): void {
    this.spans.push(span);
    for (const exporter of this.exporters) {
      try {
        exporter.exportSpan(span);
      } catch {
        // Exporters must not break span lifecycle.
      }
    }
  }

  /** @internal */
  recordMetric(point: MetricPoint): void {
    this.metrics.push(point);
    for (const exporter of this.exporters) {
      try {
        exporter.exportMetric?.(point);
      } catch {
        // Exporters must not break metric recording.
      }
    }
  }

  /**
   * Record a provider fallback-chain decision on the active span and metrics.
   */
  recordProviderChainEvent(event: {
    type: 'retry' | 'fallback' | 'success' | 'exhausted';
    provider: string;
    attempt: number;
    toProvider?: string;
    error?: Error;
  }): void {
    const span = this.activeSpan;
    if (span) {
      span.addEvent(`provider.${event.type}`, {
        provider: event.provider,
        attempt: event.attempt,
        ...(event.toProvider !== undefined ? { to_provider: event.toProvider } : {}),
        ...(event.error ? { error: event.error.message } : {}),
      });
    }

    if (event.type === 'retry' || event.type === 'fallback') {
      this.counter('provider.fallback_decisions', {
        provider: event.provider,
        decision: event.type,
      }).add(1);
    }

    if (event.type === 'success') {
      this.counter('provider.chain_success', { provider: event.provider }).add(1);
    }
  }

  /** Increment per-provider error counters for error-rate tracking. */
  trackProviderError(provider: string, code: string): void {
    this.counter('provider.errors', { provider, code }).add(1);
    this.counter('provider.error_total', { provider }).add(1);
  }

  /** Record a successful provider chain completion. */
  recordProviderChainSuccess(provider: string, attempt: number): void {
    this.recordProviderChainEvent({ type: 'success', provider, attempt });
  }

  /** Clear in-memory spans and metrics (for tests). */
  reset(): void {
    this.spans.length = 0;
    this.metrics.length = 0;
    this.activeStack.length = 0;
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }
}

/** Active span handle. */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  private readonly parentSpanId?: string;
  private readonly telemetry: Telemetry;
  private readonly attributes: Record<string, AttributeValue>;
  private readonly events: SpanEvent[] = [];
  private readonly startTime: number;
  private endTime?: number;
  private status: SpanStatusCode = 'unset';
  private statusMessage?: string;
  private ended = false;

  constructor(options: {
    name: string;
    traceId: string;
    parentSpanId?: string;
    attributes: Record<string, AttributeValue>;
    telemetry: Telemetry;
  }) {
    this.name = options.name;
    this.traceId = options.traceId;
    this.parentSpanId = options.parentSpanId;
    this.attributes = { ...options.attributes };
    this.telemetry = options.telemetry;
    this.spanId = randomUUID();
    this.startTime = Date.now();
  }

  /** Set a span attribute. */
  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  /** Record a timed event on the span. */
  addEvent(name: string, data?: Record<string, AttributeValue>): this {
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes: data,
    });
    return this;
  }

  /** Set span status. */
  setStatus(code: SpanStatusCode, message?: string): this {
    this.status = code;
    this.statusMessage = message;
    return this;
  }

  /** Finish the span and export it. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endTime = Date.now();
    const durationMs = this.endTime - this.startTime;

    this.telemetry.recordSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs,
      attributes: this.attributes,
      events: [...this.events],
      status: this.status === 'unset' ? 'ok' : this.status,
      statusMessage: this.statusMessage,
    });

    this.telemetry.histogram('span.duration_ms', { 'span.name': this.name }).record(durationMs);
  }
}

/** Counter metric. */
export class Counter {
  private value = 0;

  constructor(
    private readonly name: string,
    private readonly attributes: Record<string, AttributeValue> | undefined,
    private readonly telemetry: Telemetry,
  ) {}

  /** Increment the counter. */
  add(amount = 1): void {
    this.value += amount;
    this.telemetry.recordMetric({
      name: this.name,
      type: 'counter',
      value: this.value,
      attributes: this.attributes,
      timestamp: Date.now(),
    });
  }

  /** Current counter value. */
  get(): number {
    return this.value;
  }
}

/** Histogram metric. */
export class Histogram {
  private readonly values: number[] = [];

  constructor(
    private readonly name: string,
    private readonly attributes: Record<string, AttributeValue> | undefined,
    private readonly telemetry: Telemetry,
  ) {}

  /** Record an observation. */
  record(value: number): void {
    this.values.push(value);
    this.telemetry.recordMetric({
      name: this.name,
      type: 'histogram',
      value,
      attributes: this.attributes,
      timestamp: Date.now(),
    });
  }

  /** Recorded values (for tests). */
  getValues(): readonly number[] {
    return this.values;
  }
}

/** Gauge metric. */
export class Gauge {
  private value = 0;

  constructor(
    private readonly name: string,
    private readonly attributes: Record<string, AttributeValue> | undefined,
    private readonly telemetry: Telemetry,
  ) {}

  /** Set the gauge value. */
  set(value: number): void {
    this.value = value;
    this.telemetry.recordMetric({
      name: this.name,
      type: 'gauge',
      value,
      attributes: this.attributes,
      timestamp: Date.now(),
    });
  }

  /** Current gauge value. */
  get(): number {
    return this.value;
  }
}

function metricKey(name: string, attributes?: Record<string, AttributeValue>): string {
  if (!attributes || Object.keys(attributes).length === 0) {
    return name;
  }
  const sorted: Record<string, AttributeValue> = {};
  for (const key of Object.keys(attributes).sort()) {
    sorted[key] = attributes[key]!;
  }
  return `${name}:${JSON.stringify(sorted)}`;
}

/** Prints spans and metrics to the console. */
export class ConsoleExporter implements TelemetryExporter {
  exportSpan(span: SpanData): void {
    const parent = span.parentSpanId ? ` parent=${span.parentSpanId.slice(0, 8)}` : '';
    console.info(
      `[trace] ${span.name} id=${span.spanId.slice(0, 8)}${parent} ` +
        `duration=${span.durationMs?.toFixed(1) ?? '?'}ms status=${span.status}`,
    );
  }

  exportMetric(point: MetricPoint): void {
    console.info(`[metric] ${point.type} ${point.name}=${point.value}`);
  }
}

/** Stores spans and metrics in memory for tests and inspection. */
export class InMemoryExporter implements TelemetryExporter {
  readonly spans: SpanData[] = [];
  readonly metrics: MetricPoint[] = [];

  exportSpan(span: SpanData): void {
    this.spans.push(span);
  }

  exportMetric(point: MetricPoint): void {
    this.metrics.push(point);
  }

  clear(): void {
    this.spans.length = 0;
    this.metrics.length = 0;
  }
}

/**
 * Bridge interface for OpenTelemetry adapters (implemented by consumers).
 *
 * @example
 * ```ts
 * class OtlpExporter implements OpenTelemetryBridge {
 *   exportSpan(span) { otelTracer.startSpan(span.name); }
 * }
 * ```
 */
export interface OpenTelemetryBridge extends TelemetryExporter {
  /** Adapter name for diagnostics. */
  readonly bridgeName: string;
}

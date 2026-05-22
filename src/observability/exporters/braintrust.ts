import { logExporterError, safeFetch } from './shared.js';
import type { SpanData, TraceData, TraceExporter } from './types.js';

/** Options for {@link BraintrustExporter}. */
export interface BraintrustExporterOptions {
  apiKey: string;
  projectName: string;
  baseUrl?: string;
  projectId?: string;
  fetchImpl?: typeof fetch;
}

/** Exports {@link TraceData} to Braintrust project logs. */
export class BraintrustExporter implements TraceExporter {
  readonly name = 'braintrust';

  private readonly apiKey: string;
  private readonly projectName: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private projectId?: string;
  private readonly explicitProjectId?: string;
  private projectIdPromise?: Promise<string | undefined>;

  constructor(options: BraintrustExporterOptions) {
    this.apiKey = options.apiKey;
    this.projectName = options.projectName;
    this.baseUrl = (options.baseUrl ?? 'https://api.braintrust.dev').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.explicitProjectId = options.projectId;
  }

  async export(trace: TraceData): Promise<void> {
    const projectId = await this.resolveProjectId();
    if (!projectId) {
      return;
    }

    const events = translateTraceToBraintrustEvents(trace);
    const response = await safeFetch(
      `${this.baseUrl}/v1/project_logs/${projectId}/insert`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ events }),
      },
      this.fetchImpl,
    );

    if (!response) {
      return;
    }

    if (response.status === 401 || response.status === 403) {
      logExporterError(this.name, 'Authentication failed');
      return;
    }

    if (!response.ok) {
      logExporterError(this.name, `Unexpected response status ${response.status}`);
    }
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}

  /** Translate internal trace data to Braintrust log events (for tests). */
  translateTrace(trace: TraceData): Record<string, unknown>[] {
    return translateTraceToBraintrustEvents(trace);
  }

  private resolveProjectId(): Promise<string | undefined> {
    if (this.explicitProjectId) {
      return Promise.resolve(this.explicitProjectId);
    }
    if (this.projectId) {
      return Promise.resolve(this.projectId);
    }
    if (!this.projectIdPromise) {
      this.projectIdPromise = this.fetchProjectId().finally(() => {
        this.projectIdPromise = undefined;
      });
    }
    return this.projectIdPromise;
  }

  private async fetchProjectId(): Promise<string | undefined> {
    const response = await safeFetch(
      `${this.baseUrl}/v1/project`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: this.projectName }),
      },
      this.fetchImpl,
    );

    if (!response?.ok) {
      logExporterError(this.name, `Failed to resolve project "${this.projectName}"`);
      return undefined;
    }

    try {
      const body = (await response.json()) as { id?: string };
      if (!body.id) {
        logExporterError(this.name, 'Project resolution response missing id');
        return undefined;
      }
      this.projectId = body.id;
      return body.id;
    } catch (error) {
      logExporterError(this.name, 'Failed to parse project resolution response', error);
      return undefined;
    }
  }
}

function translateTraceToBraintrustEvents(trace: TraceData): Record<string, unknown>[] {
  const scores = readScores(trace.metadata.scores ?? trace.attributes.scores);
  const metrics = extractSpanMetrics(trace);

  const rootEvent: Record<string, unknown> = {
    id: trace.traceId,
    span_id: trace.traceId,
    root_span_id: trace.traceId,
    is_root: true,
    input: trace.input ?? trace.attributes['trace.input'] ?? { name: trace.name },
    output: trace.output ?? trace.attributes['trace.output'],
    scores,
    metadata: {
      ...trace.metadata,
      status: trace.status,
      attributes: trace.attributes,
      metrics,
    },
    tags: ['agent-kit'],
    metrics,
  };

  const childEvents = trace.spans.map((span) => translateSpanToBraintrustEvent(trace, span));
  return [rootEvent, ...childEvents];
}

function translateSpanToBraintrustEvent(
  trace: TraceData,
  span: SpanData,
): Record<string, unknown> {
  return {
    id: span.spanId,
    span_id: span.spanId,
    root_span_id: trace.traceId,
    span_parents: span.parentSpanId ? [span.parentSpanId] : [trace.traceId],
    name: span.name,
    input: span.attributes['trace.input'],
    output: span.attributes['trace.output'],
    metrics: {
      duration_ms: span.endTime - span.startTime,
    },
    metadata: {
      attributes: span.attributes,
      events: span.events,
    },
  };
}

function readScores(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const scores: Record<string, number> = {};
  for (const [key, score] of Object.entries(value as Record<string, unknown>)) {
    if (typeof score === 'number' && Number.isFinite(score)) {
      scores[key] = score;
    }
  }

  return Object.keys(scores).length > 0 ? scores : undefined;
}

function extractSpanMetrics(trace: TraceData): Record<string, number> {
  const metrics: Record<string, number> = {
    duration_ms: trace.endTime - trace.startTime,
    span_count: trace.spans.length,
  };

  for (const key of [
    'ttftMs',
    'totalLatencyMs',
    'tokensPerSecond',
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ] as const) {
    const value = trace.attributes[key];
    if (typeof value === 'number') {
      metrics[key] = value;
    }
  }

  return metrics;
}

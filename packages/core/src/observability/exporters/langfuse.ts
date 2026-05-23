import { createEventId, logExporterError, safeFetch, toIsoTimestamp } from './shared.js';
import type { SpanData, TraceData, TraceExporter } from './types.js';

/** Options for {@link LangfuseExporter}. */
export interface LangfuseExporterOptions {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushIntervalMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

interface LangfuseBatchEvent {
  id: string;
  timestamp: string;
  type: string;
  body: Record<string, unknown>;
}

/** Exports {@link TraceData} to Langfuse via the public ingestion API. */
export class LangfuseExporter implements TraceExporter {
  readonly name = 'langfuse';

  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly buffer: TraceData[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private flushing = false;

  constructor(options: LangfuseExporterOptions) {
    this.publicKey = options.publicKey;
    this.secretKey = options.secretKey;
    this.baseUrl = (options.baseUrl ?? 'https://cloud.langfuse.com').replace(/\/$/, '');
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 10;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async export(trace: TraceData): Promise<void> {
    if (this.closed) {
      return;
    }
    this.buffer.push(trace);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    const events = batch.flatMap((trace) => translateTraceToLangfuseEvents(trace));

    try {
      const delivered = await this.sendBatch(events);
      if (!delivered) {
        this.buffer.unshift(...batch);
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  /** Translate internal trace data to Langfuse ingestion events (for tests). */
  translateTrace(trace: TraceData): LangfuseBatchEvent[] {
    return translateTraceToLangfuseEvents(trace);
  }

  private async sendBatch(events: LangfuseBatchEvent[]): Promise<boolean> {
    if (events.length === 0) {
      return true;
    }

    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64');
    const response = await safeFetch(
      `${this.baseUrl}/api/public/ingestion`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batch: events }),
      },
      this.fetchImpl,
    );

    if (!response) {
      logExporterError(this.name, 'Network error while sending batch');
      return false;
    }

    if (response.status === 401 || response.status === 403) {
      logExporterError(this.name, 'Authentication failed');
      return false;
    }

    if (response.status === 429) {
      logExporterError(this.name, 'Rate limited');
      return false;
    }

    if (!response.ok && response.status !== 207) {
      logExporterError(this.name, `Unexpected response status ${response.status}`);
      return false;
    }

    return true;
  }
}

function translateTraceToLangfuseEvents(trace: TraceData): LangfuseBatchEvent[] {
  const events: LangfuseBatchEvent[] = [];
  const traceTimestamp = toIsoTimestamp(trace.startTime);

  events.push({
    id: createEventId(),
    timestamp: traceTimestamp,
    type: 'trace-create',
    body: {
      id: trace.traceId,
      timestamp: traceTimestamp,
      name: trace.name,
      input: trace.input,
      output: trace.output,
      metadata: {
        ...trace.metadata,
        status: trace.status,
        attributes: trace.attributes,
      },
    },
  });

  for (const span of trace.spans) {
    events.push(...translateSpanToLangfuseEvents(trace.traceId, span));
  }

  return events;
}

function translateSpanToLangfuseEvents(traceId: string, span: SpanData): LangfuseBatchEvent[] {
  if (isLlmSpan(span.name)) {
    return [createGenerationEvent(traceId, span)];
  }

  return [createSpanEvent(traceId, span)];
}

function createGenerationEvent(traceId: string, span: SpanData): LangfuseBatchEvent {
  const usage = readTokenUsage(span.attributes);
  const ttftMs = readNumber(span.attributes['llm.ttft_ms'] ?? span.attributes.ttftMs);
  const totalMs = readNumber(span.attributes['llm.total_ms'] ?? span.attributes.totalLatencyMs);
  const isError = span.attributes.status === 'error';

  return {
    id: createEventId(),
    timestamp: toIsoTimestamp(span.startTime),
    type: 'generation-create',
    body: {
      id: span.spanId,
      traceId,
      parentObservationId: span.parentSpanId,
      name: span.name,
      startTime: toIsoTimestamp(span.startTime),
      endTime: toIsoTimestamp(span.endTime),
      completionStartTime:
        ttftMs !== undefined ? toIsoTimestamp(span.startTime + ttftMs) : undefined,
      model: span.attributes['llm.model'] ?? span.attributes.model,
      level: isError ? 'ERROR' : 'DEFAULT',
      statusMessage:
        typeof span.attributes.statusMessage === 'string' ? span.attributes.statusMessage : undefined,
      usage: usage
        ? {
            promptTokens: usage.inputTokens,
            completionTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
      metadata: {
        ttft_ms: ttftMs,
        total_ms: totalMs,
        tokens_per_second:
          span.attributes['llm.tokens_per_second'] ?? span.attributes.tokensPerSecond,
        ...span.attributes,
      },
    },
  };
}

function createSpanEvent(traceId: string, span: SpanData): LangfuseBatchEvent {
  const isError = span.attributes.status === 'error';

  return {
    id: createEventId(),
    timestamp: toIsoTimestamp(span.startTime),
    type: 'span-create',
    body: {
      id: span.spanId,
      traceId,
      parentObservationId: span.parentSpanId,
      name: span.name,
      startTime: toIsoTimestamp(span.startTime),
      endTime: toIsoTimestamp(span.endTime),
      level: isError ? 'ERROR' : 'DEFAULT',
      statusMessage:
        typeof span.attributes.statusMessage === 'string' ? span.attributes.statusMessage : undefined,
      metadata: span.attributes,
    },
  };
}

function isLlmSpan(name: string): boolean {
  return name === 'llm.complete' || name === 'llm.stream';
}

function readTokenUsage(attributes: Record<string, unknown>):
  | { inputTokens: number; outputTokens: number; totalTokens: number }
  | undefined {
  const inputTokens = readNumber(attributes['llm.input_tokens'] ?? attributes.inputTokens);
  const outputTokens = readNumber(attributes['llm.output_tokens'] ?? attributes.outputTokens);
  const totalTokens = readNumber(attributes['llm.total_tokens'] ?? attributes.totalTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export type { LangfuseBatchEvent };

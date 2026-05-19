import type { SpanData as TelemetrySpanData } from '../telemetry.js';
import type { SpanData, TraceData } from './types.js';

/** Build a {@link TraceData} payload from finished telemetry spans. */
export function buildTraceData(
  rootSpan: TelemetrySpanData,
  allSpans: readonly TelemetrySpanData[],
): TraceData {
  const traceSpans = allSpans.filter((span) => span.traceId === rootSpan.traceId);
  const spans = traceSpans.map(toExportSpan);
  const attributes = aggregateTraceAttributes(rootSpan, traceSpans);

  return {
    traceId: rootSpan.traceId,
    name: rootSpan.name,
    startTime: rootSpan.startTime,
    endTime: rootSpan.endTime ?? Date.now(),
    status: rootSpan.status === 'error' ? 'error' : 'ok',
    attributes,
    spans,
    metadata: extractMetadata(attributes),
    input: readStringAttribute(rootSpan.attributes['trace.input']),
    output: readStringAttribute(rootSpan.attributes['trace.output']),
  };
}

function toExportSpan(span: TelemetrySpanData): SpanData {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime ?? span.startTime,
    attributes: {
      ...span.attributes,
      status: span.status,
      ...(span.statusMessage ? { statusMessage: span.statusMessage } : {}),
      ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
    },
    events: span.events.map((event) => ({
      name: event.name,
      timestamp: event.timestamp,
      attributes: event.attributes ? { ...event.attributes } : undefined,
    })),
  };
}

function aggregateTraceAttributes(
  rootSpan: TelemetrySpanData,
  traceSpans: TelemetrySpanData[],
): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...rootSpan.attributes };

  for (const span of traceSpans) {
    if (span.name.startsWith('llm.')) {
      overwriteIfPresent(attributes, span.attributes, 'llm.model', 'model');
      addNumeric(attributes, span.attributes, 'llm.input_tokens', 'inputTokens');
      addNumeric(attributes, span.attributes, 'llm.output_tokens', 'outputTokens');
      addNumeric(attributes, span.attributes, 'llm.total_tokens', 'totalTokens');
      overwriteIfPresent(attributes, span.attributes, 'llm.ttft_ms', 'ttftMs');
      overwriteIfPresent(attributes, span.attributes, 'llm.total_ms', 'totalLatencyMs');
      overwriteIfPresent(attributes, span.attributes, 'llm.tokens_per_second', 'tokensPerSecond');
      overwriteIfPresent(attributes, span.attributes, 'component', 'provider');
    }
  }

  return attributes;
}

function extractMetadata(attributes: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('metadata.')) {
      metadata[key.slice('metadata.'.length)] = value;
    }
  }
  if (attributes.scores && typeof attributes.scores === 'object') {
    metadata.scores = attributes.scores;
  }
  return metadata;
}

function overwriteIfPresent(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = source[sourceKey];
  }
}

function addNumeric(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  const value = source[sourceKey];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return;
  }
  const existing = target[targetKey];
  target[targetKey] = typeof existing === 'number' ? existing + value : value;
}

function readStringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

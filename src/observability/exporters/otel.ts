import { getRunContext, type RunContext } from '../../context/run-context.js';
import { logExporterError, sleep } from './shared.js';
import type { SpanData, TraceData, TraceExporter } from './types.js';

/** OTLP protocol version. */
export const OTLP_PROTOCOL_VERSION = '1.0.0';

/** Ottrix instrumentation scope version (matches package version). */
export const OTTRIX_INSTRUMENTATION_VERSION = '1.0.0';

/** Span attribute keys stripped before OTLP export (internal trace-builder fields). */
const INTERNAL_SPAN_ATTRIBUTE_KEYS = new Set(['status', 'statusMessage', 'durationMs']);

/** Default HTTP request timeout for OTLP export. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Maximum buffered spans before oldest batches are dropped. */
const DEFAULT_MAX_BUFFER_SIZE = 10_000;

interface BufferedSpan {
  span: OtlpSpan;
  runContext?: RunContext;
}

/** Options for {@link OtelExporter}. */
export interface OtelExporterOptions {
  /** OTLP endpoint (e.g., 'http://localhost:4318'). */
  endpoint: string;
  /** Transport protocol. @defaultValue 'http' */
  protocol?: 'grpc' | 'http';
  /** Authentication headers for hosted backends. */
  headers?: Record<string, string>;
  /** OTEL service.name resource attribute. @defaultValue 'ottrix' */
  serviceName?: string;
  /** OTEL service.version resource attribute. */
  serviceVersion?: string;
  /** Extra OTEL resource attributes. */
  resourceAttributes?: Record<string, string>;
  /** Batch span export size. @defaultValue 50 */
  batchSize?: number;
  /** Auto-flush interval in milliseconds. @defaultValue 5000 */
  flushIntervalMs?: number;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
  /** Maximum retry attempts for 5xx errors. @defaultValue 3 */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. @defaultValue 1000 */
  retryBaseDelayMs?: number;
  /** HTTP request timeout in ms. @defaultValue 30000 */
  fetchTimeoutMs?: number;
  /** Max buffered spans before dropping oldest. @defaultValue 10000 */
  maxBufferSize?: number;
}

/** OTLP KeyValue attribute. */
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** OTLP AnyValue union. */
export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
}

/** OTLP Span status. */
export interface OtlpStatus {
  code: number;
  message?: string;
}

/** OTLP Span event. */
export interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes?: OtlpKeyValue[];
}

/** OTLP Span representation. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: OtlpEvent[];
  status: OtlpStatus;
}

/** OTLP Resource representation. */
export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

/** OTLP ScopeSpans representation. */
export interface OtlpScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

/** OTLP ResourceSpans representation. */
export interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

/** OTLP ExportTraceServiceRequest payload. */
export interface OtlpExportTraceServiceRequest {
  resourceSpans: OtlpResourceSpans[];
}

/** Semantic attribute names for GenAI (OpenTelemetry GenAI SIG). */
export const GEN_AI_ATTRIBUTES = {
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  RESPONSE_MODEL: 'gen_ai.response.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  RESPONSE_FINISH_REASON: 'gen_ai.response.finish_reason',
} as const;

/** Ottrix-specific semantic attribute names. */
export const OTTRIX_ATTRIBUTES = {
  AGENT_NAME: 'ottrix.agent.name',
  RUN_ID: 'ottrix.run.id',
  STEP_ID: 'ottrix.step.id',
  TOOL_NAME: 'ottrix.tool.name',
  TOOL_SIDE_EFFECT: 'ottrix.tool.side_effect',
  COST_USD: 'ottrix.cost.usd',
  TTFT_MS: 'ottrix.ttft_ms',
  TOKENS_PER_SECOND: 'ottrix.tokens_per_second',
} as const;

/** OTLP span kind constants. */
const SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

/** OTLP status code constants. */
const STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

/**
 * Maps ottrix span names to OTLP semantic convention names.
 */
function mapSpanName(name: string): string {
  const mappings: Record<string, string> = {
    'agent.run': 'ottrix.agent.run',
    'llm.complete': 'ottrix.llm.complete',
    'llm.stream': 'ottrix.llm.stream',
    'tool.execute': 'ottrix.tool.execute',
    'workflow.step': 'ottrix.workflow.step',
    'workflow.gate': 'ottrix.workflow.gate',
    'guardrail.check': 'ottrix.guardrail.check',
  };
  return mappings[name] ?? `ottrix.${name}`;
}

/**
 * Converts epoch milliseconds to OTLP nanoseconds string.
 */
function msToNanoString(ms: number): string {
  return String(BigInt(Math.floor(ms)) * BigInt(1_000_000));
}

/**
 * Converts a value to OTLP AnyValue format.
 */
function toOtlpValue(value: unknown): OtlpAnyValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => toOtlpValue(entry) ?? { stringValue: '' }) } };
  }
  if (typeof value === 'object') {
    const kvList: OtlpKeyValue[] = [];
    for (const [k, v] of Object.entries(value)) {
      const otlpValue = toOtlpValue(v);
      if (otlpValue) {
        kvList.push({ key: k, value: otlpValue });
      }
    }
    return { kvlistValue: { values: kvList } };
  }
  if (typeof value === 'bigint') {
    return { stringValue: value.toString() };
  }
  if (typeof value === 'symbol') {
    return { stringValue: value.toString() };
  }
  if (typeof value === 'function') {
    return { stringValue: value.name || '[function]' };
  }
  return undefined;
}

/**
 * Converts a record of attributes to OTLP KeyValue array.
 */
function toOtlpAttributes(attributes: Record<string, unknown>): OtlpKeyValue[] {
  const result: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) {
      continue;
    }
    const otlpValue = toOtlpValue(value);
    if (otlpValue) {
      result.push({ key, value: otlpValue });
    }
  }
  return result;
}

/**
 * Generates a 32-character hex trace ID from a UUID.
 */
function toOtlpTraceId(traceId: string): string {
  const hex = traceId.replace(/-/g, '');
  return hex.padStart(32, '0').slice(0, 32);
}

/**
 * Generates a 16-character hex span ID from a UUID.
 */
function toOtlpSpanId(spanId: string): string {
  const hex = spanId.replace(/-/g, '');
  return hex.slice(0, 16).padStart(16, '0');
}

/**
 * Maps ottrix LLM provider names to GenAI system names.
 */
function mapProviderToGenAiSystem(provider: unknown): string | undefined {
  if (typeof provider !== 'string') {
    return undefined;
  }
  const normalized = provider.toLowerCase();
  if (normalized.includes('anthropic') || normalized.includes('claude')) {
    return 'anthropic';
  }
  if (normalized.includes('openai') || normalized.includes('gpt')) {
    return 'openai';
  }
  if (normalized.includes('ollama')) {
    return 'ollama';
  }
  if (normalized.includes('google') || normalized.includes('gemini')) {
    return 'google';
  }
  return provider;
}

/**
 * Determines span kind based on span name.
 */
function determineSpanKind(name: string): number {
  if (name.startsWith('llm.') || name.includes('tool.')) {
    return SPAN_KIND.CLIENT;
  }
  if (name.includes('agent.') || name.includes('workflow.')) {
    return SPAN_KIND.INTERNAL;
  }
  return SPAN_KIND.INTERNAL;
}

/**
 * Enriches attributes with GenAI semantic conventions.
 */
function enrichWithGenAiAttributes(
  spanName: string,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = {};

  if (spanName.startsWith('llm.')) {
    const provider = attributes['component'] ?? attributes['provider'];
    const system = mapProviderToGenAiSystem(provider);
    if (system) {
      enriched[GEN_AI_ATTRIBUTES.SYSTEM] = system;
    }

    const model = attributes['llm.model'] ?? attributes['model'];
    if (model) {
      enriched[GEN_AI_ATTRIBUTES.REQUEST_MODEL] = model;
      enriched[GEN_AI_ATTRIBUTES.RESPONSE_MODEL] = model;
    }

    const maxTokens = attributes['llm.max_tokens'] ?? attributes['maxTokens'];
    if (typeof maxTokens === 'number') {
      enriched[GEN_AI_ATTRIBUTES.REQUEST_MAX_TOKENS] = maxTokens;
    }

    const temperature = attributes['llm.temperature'] ?? attributes['temperature'];
    if (typeof temperature === 'number') {
      enriched[GEN_AI_ATTRIBUTES.REQUEST_TEMPERATURE] = temperature;
    }

    const inputTokens = attributes['llm.input_tokens'] ?? attributes['inputTokens'];
    if (typeof inputTokens === 'number') {
      enriched[GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS] = inputTokens;
    }

    const outputTokens = attributes['llm.output_tokens'] ?? attributes['outputTokens'];
    if (typeof outputTokens === 'number') {
      enriched[GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS] = outputTokens;
    }

    const finishReason = attributes['llm.finish_reason'] ?? attributes['finishReason'];
    if (typeof finishReason === 'string') {
      enriched[GEN_AI_ATTRIBUTES.RESPONSE_FINISH_REASON] = finishReason;
    } else if (finishReason !== undefined && finishReason !== null) {
      enriched[GEN_AI_ATTRIBUTES.RESPONSE_FINISH_REASON] = JSON.stringify(finishReason);
    }
  }

  return enriched;
}

/**
 * Enriches attributes with ottrix-specific conventions.
 */
function enrichWithOttrixAttributes(
  spanName: string,
  attributes: Record<string, unknown>,
  runContext?: RunContext,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = {};

  if (runContext?.runId) {
    enriched[OTTRIX_ATTRIBUTES.RUN_ID] = runContext.runId;
  }
  if (runContext?.stepId) {
    enriched[OTTRIX_ATTRIBUTES.STEP_ID] = runContext.stepId;
  }
  if (runContext?.agentName) {
    enriched[OTTRIX_ATTRIBUTES.AGENT_NAME] = runContext.agentName;
  }

  const agentName = attributes['agent.name'];
  if (agentName && !enriched[OTTRIX_ATTRIBUTES.AGENT_NAME]) {
    enriched[OTTRIX_ATTRIBUTES.AGENT_NAME] = agentName;
  }

  if (spanName.includes('tool.')) {
    const toolName = attributes['tool.name'] ?? attributes['tool'];
    if (toolName) {
      enriched[OTTRIX_ATTRIBUTES.TOOL_NAME] = toolName;
    }
    const sideEffect = attributes['tool.side_effect'] ?? attributes['sideEffect'];
    if (sideEffect !== undefined && sideEffect !== null) {
      enriched[OTTRIX_ATTRIBUTES.TOOL_SIDE_EFFECT] = sideEffect;
    }
  }

  const ttftMs = attributes['llm.ttft_ms'] ?? attributes['ttftMs'];
  if (typeof ttftMs === 'number') {
    enriched[OTTRIX_ATTRIBUTES.TTFT_MS] = ttftMs;
  }

  const tokensPerSecond = attributes['llm.tokens_per_second'] ?? attributes['tokensPerSecond'];
  if (typeof tokensPerSecond === 'number') {
    enriched[OTTRIX_ATTRIBUTES.TOKENS_PER_SECOND] = tokensPerSecond;
  }

  const costUsd = attributes['llm.cost_usd'] ?? attributes['costUsd'];
  if (typeof costUsd === 'number') {
    enriched[OTTRIX_ATTRIBUTES.COST_USD] = costUsd;
  }

  return enriched;
}

/**
 * Exports {@link TraceData} to an OpenTelemetry OTLP endpoint.
 *
 * Translates ottrix spans to OTLP format with GenAI semantic conventions
 * and exports via OTLP/HTTP JSON (no protobuf/grpc dependency).
 *
 * @example
 * ```ts
 * const exporter = new OtelExporter({
 *   endpoint: 'http://localhost:4318',
 *   serviceName: 'my-agent',
 *   headers: { 'x-api-key': 'my-key' },
 * });
 * telemetry.addExporter(exporter);
 * ```
 */
export class OtelExporter implements TraceExporter {
  readonly name = 'otel';

  private readonly endpoint: string;
  private readonly protocol: 'grpc' | 'http';
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly serviceVersion?: string;
  private readonly resourceAttributes: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxBufferSize: number;
  private readonly buffer: BufferedSpan[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private flushing = false;
  private flushPromise: Promise<void> | undefined;
  private langfuseTraceId?: string;

  constructor(options: OtelExporterOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.protocol = options.protocol ?? 'http';
    this.headers = options.headers ?? {};
    this.serviceName = options.serviceName ?? 'ottrix';
    this.serviceVersion = options.serviceVersion;
    this.resourceAttributes = options.resourceAttributes ?? {};
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

    if (this.protocol === 'grpc') {
      throw new Error('gRPC protocol is not supported; use "http" for OTLP/HTTP JSON');
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /**
   * Set the Langfuse trace ID for cross-linking.
   * Call this when a Langfuse exporter is also active.
   */
  setLangfuseTraceId(traceId: string): void {
    this.langfuseTraceId = traceId;
  }

  async export(trace: TraceData): Promise<void> {
    if (this.closed) {
      return;
    }

    const runContext = getRunContext();
    const otlpSpans = this.translateTrace(trace, runContext);
    for (const span of otlpSpans) {
      this.buffer.push({ span, runContext });
    }

    this.enforceBufferLimit();

    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
    }
    if (this.buffer.length === 0) {
      return;
    }

    this.flushPromise = this.flushInternal();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = undefined;
    }
  }

  private async flushInternal(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      const delivered = await this.sendBatch(batch);
      if (!delivered) {
        if (this.closed) {
          logExporterError(this.name, `Dropping ${batch.length} spans after failed shutdown flush`);
        } else {
          this.buffer.unshift(...batch);
          this.enforceBufferLimit();
        }
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

    let attempts = 0;
    while (this.buffer.length > 0 && attempts <= this.maxRetries) {
      const sizeBefore = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= sizeBefore) {
        attempts += 1;
      }
    }

    if (this.buffer.length > 0) {
      logExporterError(
        this.name,
        `Dropping ${this.buffer.length} buffered spans after shutdown (${attempts} failed flush attempts)`,
      );
      this.buffer.length = 0;
    }
  }

  private enforceBufferLimit(): void {
    if (this.buffer.length <= this.maxBufferSize) {
      return;
    }
    const dropped = this.buffer.length - this.maxBufferSize;
    this.buffer.splice(0, dropped);
    logExporterError(this.name, `Buffer limit exceeded; dropped ${dropped} oldest spans`);
  }

  /**
   * Translate ottrix trace to OTLP spans (exposed for testing).
   */
  translateTrace(trace: TraceData, runContext?: RunContext): OtlpSpan[] {
    const otlpSpans: OtlpSpan[] = [];

    for (const span of trace.spans) {
      const otlpSpan = this.translateSpan(trace.traceId, span, runContext);
      otlpSpans.push(otlpSpan);
    }

    return otlpSpans;
  }

  /**
   * Translate a single ottrix span to OTLP format.
   */
  translateSpan(traceId: string, span: SpanData, runContext?: RunContext): OtlpSpan {
    const otlpTraceId = toOtlpTraceId(traceId);
    const otlpSpanId = toOtlpSpanId(span.spanId);
    const otlpParentSpanId = span.parentSpanId ? toOtlpSpanId(span.parentSpanId) : undefined;
    const otlpName = mapSpanName(span.name);

    const genAiAttributes = enrichWithGenAiAttributes(span.name, span.attributes);
    const ottrixAttributes = enrichWithOttrixAttributes(span.name, span.attributes, runContext);

    const exportAttributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(span.attributes)) {
      if (!INTERNAL_SPAN_ATTRIBUTE_KEYS.has(key)) {
        exportAttributes[key] = value;
      }
    }

    const allAttributes: Record<string, unknown> = {
      ...exportAttributes,
      ...genAiAttributes,
      ...ottrixAttributes,
    };

    if (this.langfuseTraceId) {
      allAttributes['langfuse.trace_id'] = this.langfuseTraceId;
    }

    const status = span.attributes['status'];
    const statusCode =
      status === 'error' ? STATUS_CODE.ERROR : status === 'ok' ? STATUS_CODE.OK : STATUS_CODE.UNSET;
    const statusMessage =
      typeof span.attributes['statusMessage'] === 'string'
        ? span.attributes['statusMessage']
        : undefined;

    const otlpEvents: OtlpEvent[] = span.events.map((event) => ({
      timeUnixNano: msToNanoString(event.timestamp),
      name: event.name,
      attributes: event.attributes ? toOtlpAttributes(event.attributes) : undefined,
    }));

    return {
      traceId: otlpTraceId,
      spanId: otlpSpanId,
      parentSpanId: otlpParentSpanId,
      name: otlpName,
      kind: determineSpanKind(span.name),
      startTimeUnixNano: msToNanoString(span.startTime),
      endTimeUnixNano: msToNanoString(span.endTime),
      attributes: toOtlpAttributes(allAttributes),
      events: otlpEvents,
      status: {
        code: statusCode,
        message: statusMessage,
      },
    };
  }

  /**
   * Build the OTLP resource with service attributes.
   */
  buildResource(runContext?: RunContext): OtlpResource {
    const attributes: Record<string, string> = {
      'service.name': this.serviceName,
      ...this.resourceAttributes,
    };

    if (this.serviceVersion) {
      attributes['service.version'] = this.serviceVersion;
    }

    if (runContext?.runId) {
      attributes[OTTRIX_ATTRIBUTES.RUN_ID] = runContext.runId;
    }
    if (runContext?.agentName) {
      attributes[OTTRIX_ATTRIBUTES.AGENT_NAME] = runContext.agentName;
    }

    return {
      attributes: toOtlpAttributes(attributes),
    };
  }

  /**
   * Build the full OTLP export request payload.
   */
  buildExportRequest(entries: BufferedSpan[]): OtlpExportTraceServiceRequest {
    const grouped = new Map<string, { runContext?: RunContext; spans: OtlpSpan[] }>();

    for (const entry of entries) {
      const key = `${entry.runContext?.runId ?? ''}:${entry.runContext?.agentName ?? ''}`;
      const group = grouped.get(key);
      if (group) {
        group.spans.push(entry.span);
      } else {
        grouped.set(key, { runContext: entry.runContext, spans: [entry.span] });
      }
    }

    const resourceSpans: OtlpResourceSpans[] = [];
    for (const group of grouped.values()) {
      resourceSpans.push({
        resource: this.buildResource(group.runContext),
        scopeSpans: [
          {
            scope: {
              name: 'ottrix',
              version: this.serviceVersion ?? OTTRIX_INSTRUMENTATION_VERSION,
            },
            spans: group.spans,
          },
        ],
      });
    }

    return { resourceSpans };
  }

  private async sendBatch(entries: BufferedSpan[]): Promise<boolean> {
    if (entries.length === 0) {
      return true;
    }

    const payload = this.buildExportRequest(entries);
    const url = `${this.endpoint}/v1/traces`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            ...this.headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.fetchTimeoutMs),
        });

        if (response.ok || response.status === 200 || response.status === 202) {
          return true;
        }

        if (response.status === 429 && attempt < this.maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
          logExporterError(
            this.name,
            `Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`,
          );
          await sleep(delay);
          continue;
        }

        if (isPermanentClientError(response.status)) {
          logExporterError(this.name, `Client error ${response.status}, dropping batch`);
          return true;
        }

        if (response.status >= 500 && attempt < this.maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
          logExporterError(
            this.name,
            `Server error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`,
          );
          await sleep(delay);
          continue;
        }

        logExporterError(this.name, `Failed after ${attempt + 1} attempts with status ${response.status}`);
        return false;
      } catch (error) {
        if (attempt < this.maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
          logExporterError(this.name, `Network error, retrying in ${delay}ms`, error);
          await sleep(delay);
          continue;
        }
        logExporterError(this.name, `Network error after ${attempt + 1} attempts`, error);
        return false;
      }
    }

    return false;
  }

  /** Current buffer size (for testing). */
  get bufferSize(): number {
    return this.buffer.length;
  }

  /** Whether the exporter is closed. */
  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Creates an OtelExporter configured for common backends.
 */
export function createOtelExporter(
  backend: 'jaeger' | 'datadog' | 'honeycomb' | 'tempo' | 'custom',
  options: Partial<OtelExporterOptions> & { endpoint?: string; apiKey?: string },
): OtelExporter {
  const defaults: Record<string, Partial<OtelExporterOptions>> = {
    jaeger: {
      endpoint: options.endpoint ?? 'http://localhost:4318',
    },
    datadog: {
      endpoint: options.endpoint ?? 'https://otlp.datadoghq.com',
      headers: options.apiKey ? { 'DD-API-KEY': options.apiKey } : {},
    },
    honeycomb: {
      endpoint: options.endpoint ?? 'https://api.honeycomb.io',
      headers: options.apiKey ? { 'x-honeycomb-team': options.apiKey } : {},
    },
    tempo: {
      endpoint: options.endpoint ?? 'http://localhost:4318',
    },
    custom: {
      endpoint: options.endpoint ?? 'http://localhost:4318',
    },
  };

  const backendDefaults = defaults[backend] ?? defaults.custom;
  const { apiKey, ...restOptions } = options;
  void apiKey;

  return new OtelExporter({
    ...backendDefaults,
    ...restOptions,
    endpoint: options.endpoint ?? backendDefaults.endpoint ?? 'http://localhost:4318',
    headers: { ...backendDefaults.headers, ...options.headers },
  });
}

function isPermanentClientError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

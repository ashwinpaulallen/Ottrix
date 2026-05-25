import { getRunContext, type RunContext, type SpanData, type TraceData, type TraceExporter } from 'ottrix';

/** GenAI semantic convention attribute names. */
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
  COST_USD: 'ottrix.cost.usd',
  TTFT_MS: 'ottrix.ttft_ms',
} as const;

/** Options for {@link OtelExporter}. */
export interface OtelExporterOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: Array<{ timeUnixNano: string; name: string; attributes?: OtlpKeyValue[] }>;
  status: { code: number; message?: string };
}

interface BufferedSpan {
  span: OtlpSpan;
  runContext?: RunContext;
}

const INTERNAL_ATTRS = new Set(['status', 'statusMessage', 'durationMs']);
const SPAN_KIND_CLIENT = 3;
const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Exports ottrix traces to an OTLP/HTTP JSON endpoint. */
export class OtelExporter implements TraceExporter {
  readonly name = 'otel';

  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly buffer: BufferedSpan[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private flushing = false;

  constructor(options: OtelExporterOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://localhost:4318').replace(/\/$/, '');
    this.headers = options.headers ?? {};
    this.serviceName = options.serviceName ?? 'ottrix';
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;

    this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async export(trace: TraceData): Promise<void> {
    if (this.closed) return;
    const runContext = getRunContext();
    for (const span of this.translateTrace(trace, runContext)) {
      this.buffer.push({ span, runContext });
    }
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const delivered = await this.sendBatch(batch);
      if (!delivered && !this.closed) {
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

  translateTrace(trace: TraceData, runContext?: RunContext): OtlpSpan[] {
    return trace.spans.map((span) => this.translateSpan(trace.traceId, span, runContext));
  }

  translateSpan(traceId: string, span: SpanData, runContext?: RunContext): OtlpSpan {
    const attrs = this.buildAttributes(span, runContext);
    const status = span.attributes.status;
    return {
      traceId: toHexTraceId(traceId),
      spanId: toHexSpanId(span.spanId),
      parentSpanId: span.parentSpanId ? toHexSpanId(span.parentSpanId) : undefined,
      name: mapSpanName(span.name),
      kind: span.name.startsWith('llm.') || span.name.includes('tool.') ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(span.startTime),
      endTimeUnixNano: msToNano(span.endTime),
      attributes: toOtlpAttributes(attrs),
      events: span.events.map((event) => ({
        timeUnixNano: msToNano(event.timestamp),
        name: event.name,
        attributes: event.attributes ? toOtlpAttributes(event.attributes) : undefined,
      })),
      status: {
        code: status === 'error' ? STATUS_ERROR : STATUS_OK,
        message: typeof span.attributes.statusMessage === 'string' ? span.attributes.statusMessage : undefined,
      },
    };
  }

  buildExportRequest(entries: BufferedSpan[]): { resourceSpans: unknown[] } {
    const groups = new Map<string, BufferedSpan[]>();
    for (const entry of entries) {
      const key = `${entry.runContext?.runId ?? ''}:${entry.runContext?.agentName ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }

    return {
      resourceSpans: [...groups.entries()].map(([, group]) => ({
        resource: {
          attributes: toOtlpAttributes({
            'service.name': this.serviceName,
            ...(group[0]?.runContext?.runId ? { [OTTRIX_ATTRIBUTES.RUN_ID]: group[0].runContext!.runId } : {}),
          }),
        },
        scopeSpans: [{ scope: { name: 'ottrix', version: '1.0.0' }, spans: group.map((entry) => entry.span) }],
      })),
    };
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private buildAttributes(span: SpanData, runContext?: RunContext): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(span.attributes)) {
      if (!INTERNAL_ATTRS.has(key)) attrs[key] = value;
    }
    Object.assign(attrs, enrichGenAi(span.name, span.attributes));
    if (runContext?.runId) attrs[OTTRIX_ATTRIBUTES.RUN_ID] = runContext.runId;
    if (runContext?.stepId) attrs[OTTRIX_ATTRIBUTES.STEP_ID] = runContext.stepId;
    if (runContext?.agentName) attrs[OTTRIX_ATTRIBUTES.AGENT_NAME] = runContext.agentName;
    const ttft = span.attributes['llm.ttft_ms'] ?? span.attributes.ttftMs;
    if (typeof ttft === 'number') attrs[OTTRIX_ATTRIBUTES.TTFT_MS] = ttft;
    const cost = span.attributes['llm.cost_usd'] ?? span.attributes.costUsd;
    if (typeof cost === 'number') attrs[OTTRIX_ATTRIBUTES.COST_USD] = cost;
    if (span.name.includes('tool.')) {
      const tool = span.attributes['tool.name'] ?? span.attributes.tool;
      if (tool) attrs[OTTRIX_ATTRIBUTES.TOOL_NAME] = tool;
    }
    return attrs;
  }

  private async sendBatch(entries: BufferedSpan[]): Promise<boolean> {
    if (entries.length === 0) return true;
    const payload = this.buildExportRequest(entries);
    const url = `${this.endpoint}/v1/traces`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (response.ok || response.status === 200 || response.status === 202) return true;
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          return true;
        }
        if (attempt < this.maxRetries) {
          await sleep(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        return false;
      } catch {
        if (attempt < this.maxRetries) {
          await sleep(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        return false;
      }
    }
    return false;
  }
}

/** Factory with sensible defaults per OTLP backend. */
export function createOtelExporter(
  backend: 'jaeger' | 'tempo' | 'custom',
  options: Partial<OtelExporterOptions> = {},
): OtelExporter {
  const defaults: Record<string, Partial<OtelExporterOptions>> = {
    jaeger: { endpoint: 'http://localhost:4318' },
    tempo: { endpoint: 'http://localhost:4318' },
    custom: { endpoint: options.endpoint ?? 'http://localhost:4318' },
  };
  const preset = defaults[backend] ?? defaults.custom;
  return new OtelExporter({ ...preset, ...options, headers: { ...preset.headers, ...options.headers } });
}

function mapSpanName(name: string): string {
  const map: Record<string, string> = {
    'agent.run': 'ottrix.agent.run',
    'llm.complete': 'ottrix.llm.complete',
    'llm.stream': 'ottrix.llm.stream',
    'tool.execute': 'ottrix.tool.execute',
  };
  return map[name] ?? `ottrix.${name}`;
}

function enrichGenAi(name: string, attributes: Record<string, unknown>): Record<string, unknown> {
  if (!name.startsWith('llm.')) return {};
  const out: Record<string, unknown> = {};
  const provider = attributes.component ?? attributes.provider;
  if (typeof provider === 'string') {
    out[GEN_AI_ATTRIBUTES.SYSTEM] = provider.toLowerCase().includes('openai')
      ? 'openai'
      : provider.toLowerCase().includes('ollama')
        ? 'ollama'
        : 'anthropic';
  }
  const model = attributes['llm.model'] ?? attributes.model;
  if (model) {
    out[GEN_AI_ATTRIBUTES.REQUEST_MODEL] = model;
    out[GEN_AI_ATTRIBUTES.RESPONSE_MODEL] = model;
  }
  const input = attributes['llm.input_tokens'] ?? attributes.inputTokens;
  if (typeof input === 'number') out[GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS] = input;
  const output = attributes['llm.output_tokens'] ?? attributes.outputTokens;
  if (typeof output === 'number') out[GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS] = output;
  return out;
}

function toOtlpAttributes(attributes: Record<string, unknown>): OtlpKeyValue[] {
  const result: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') result.push({ key, value: { stringValue: value } });
    else if (typeof value === 'boolean') result.push({ key, value: { boolValue: value } });
    else if (typeof value === 'number') {
      result.push(
        Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } },
      );
    }
  }
  return result;
}

function toHexTraceId(id: string): string {
  return id.replace(/-/g, '').padStart(32, '0').slice(0, 32);
}

function toHexSpanId(id: string): string {
  return id.replace(/-/g, '').slice(0, 16).padStart(16, '0');
}

function msToNano(ms: number): string {
  return String(BigInt(Math.floor(ms)) * 1_000_000n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { SpanData, TraceData, TraceExporter };

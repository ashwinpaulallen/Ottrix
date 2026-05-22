import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GEN_AI_ATTRIBUTES,
  OtelExporter,
  OTTRIX_ATTRIBUTES,
  createOtelExporter,
  type OtlpSpan,
} from '../../src/observability/exporters/otel.js';
import type { SpanData, TraceData } from '../../src/observability/exporters/types.js';

function createTestTrace(overrides: Partial<TraceData> = {}): TraceData {
  return {
    traceId: '550e8400-e29b-41d4-a716-446655440000',
    name: 'test-trace',
    startTime: 1700000000000,
    endTime: 1700000001000,
    status: 'ok',
    attributes: {},
    spans: [],
    metadata: {},
    ...overrides,
  };
}

function createTestSpan(overrides: Partial<SpanData> = {}): SpanData {
  return {
    spanId: '123e4567-e89b-12d3-a456-426614174000',
    name: 'test-span',
    startTime: 1700000000000,
    endTime: 1700000001000,
    attributes: {},
    events: [],
    ...overrides,
  };
}

describe('OtelExporter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('span translation', () => {
    it('translates ottrix spans to correct OTLP JSON format', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [
          createTestSpan({
            spanId: '123e4567-e89b-12d3-a456-426614174000',
            parentSpanId: '987fcdeb-51a2-3b4c-d5e6-f78901234567',
            name: 'llm.complete',
            startTime: 1700000000000,
            endTime: 1700000001000,
            attributes: {
              'llm.model': 'claude-sonnet-4-20250514',
              'llm.input_tokens': 1500,
              'llm.output_tokens': 800,
              status: 'ok',
            },
            events: [
              {
                name: 'first_token',
                timestamp: 1700000000234,
                attributes: { ttft_ms: 234 },
              },
            ],
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);

      expect(otlpSpans).toHaveLength(1);
      const span = otlpSpans[0]!;

      expect(span.traceId).toHaveLength(32);
      expect(span.spanId).toHaveLength(16);
      expect(span.parentSpanId).toHaveLength(16);
      expect(span.name).toBe('ottrix.llm.complete');
      expect(span.startTimeUnixNano).toBe('1700000000000000000');
      expect(span.endTimeUnixNano).toBe('1700000001000000000');
      expect(span.kind).toBe(3);
      expect(span.status.code).toBe(1);

      expect(span.events).toHaveLength(1);
      expect(span.events[0]?.name).toBe('first_token');
      expect(span.events[0]?.timeUnixNano).toBe('1700000000234000000');
    });

    it('maps span names to OTLP conventions', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const spanNames = [
        { input: 'agent.run', expected: 'ottrix.agent.run' },
        { input: 'llm.complete', expected: 'ottrix.llm.complete' },
        { input: 'llm.stream', expected: 'ottrix.llm.stream' },
        { input: 'tool.execute', expected: 'ottrix.tool.execute' },
        { input: 'workflow.step', expected: 'ottrix.workflow.step' },
        { input: 'workflow.gate', expected: 'ottrix.workflow.gate' },
        { input: 'guardrail.check', expected: 'ottrix.guardrail.check' },
        { input: 'custom.span', expected: 'ottrix.custom.span' },
      ];

      for (const { input, expected } of spanNames) {
        const trace = createTestTrace({ spans: [createTestSpan({ name: input })] });
        const otlpSpans = exporter.translateTrace(trace);
        expect(otlpSpans[0]?.name).toBe(expected);
      }
    });

    it('converts trace and span IDs to correct hex format', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        traceId: '550e8400-e29b-41d4-a716-446655440000',
        spans: [
          createTestSpan({
            spanId: '123e4567-e89b-12d3-a456-426614174000',
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);
      const span = otlpSpans[0]!;

      expect(span.traceId).toBe('550e8400e29b41d4a716446655440000');
      expect(span.spanId).toBe('123e4567e89b12d3');
    });
  });

  describe('semantic conventions', () => {
    it('applies GenAI semantic conventions for LLM spans', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [
          createTestSpan({
            name: 'llm.complete',
            attributes: {
              component: 'anthropic',
              'llm.model': 'claude-sonnet-4-20250514',
              'llm.max_tokens': 4096,
              'llm.temperature': 0.7,
              'llm.input_tokens': 1500,
              'llm.output_tokens': 800,
              'llm.finish_reason': 'end_turn',
            },
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);
      const attrs = otlpSpans[0]!.attributes;

      const findAttr = (key: string) => attrs.find((a) => a.key === key);

      expect(findAttr(GEN_AI_ATTRIBUTES.SYSTEM)?.value.stringValue).toBe('anthropic');
      expect(findAttr(GEN_AI_ATTRIBUTES.REQUEST_MODEL)?.value.stringValue).toBe(
        'claude-sonnet-4-20250514',
      );
      expect(findAttr(GEN_AI_ATTRIBUTES.REQUEST_MAX_TOKENS)?.value.intValue).toBe('4096');
      expect(findAttr(GEN_AI_ATTRIBUTES.REQUEST_TEMPERATURE)?.value.doubleValue).toBe(0.7);
      expect(findAttr(GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS)?.value.intValue).toBe('1500');
      expect(findAttr(GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS)?.value.intValue).toBe('800');
      expect(findAttr(GEN_AI_ATTRIBUTES.RESPONSE_FINISH_REASON)?.value.stringValue).toBe(
        'end_turn',
      );
    });

    it('maps provider names to GenAI system values', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const providers = [
        { input: 'anthropic', expected: 'anthropic' },
        { input: 'Anthropic', expected: 'anthropic' },
        { input: 'claude', expected: 'anthropic' },
        { input: 'openai', expected: 'openai' },
        { input: 'OpenAI', expected: 'openai' },
        { input: 'gpt-4', expected: 'openai' },
        { input: 'ollama', expected: 'ollama' },
        { input: 'google', expected: 'google' },
        { input: 'gemini', expected: 'google' },
      ];

      for (const { input, expected } of providers) {
        const trace = createTestTrace({
          spans: [
            createTestSpan({
              name: 'llm.complete',
              attributes: { component: input },
            }),
          ],
        });
        const otlpSpans = exporter.translateTrace(trace);
        const attrs = otlpSpans[0]!.attributes;
        const systemAttr = attrs.find((a) => a.key === GEN_AI_ATTRIBUTES.SYSTEM);
        expect(systemAttr?.value.stringValue).toBe(expected);
      }
    });

    it('applies ottrix-specific attributes', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [
          createTestSpan({
            name: 'tool.execute',
            attributes: {
              'tool.name': 'web_search',
              'tool.side_effect': 'read',
              'llm.ttft_ms': 234,
              'llm.tokens_per_second': 85.3,
              'llm.cost_usd': 0.0045,
            },
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);
      const attrs = otlpSpans[0]!.attributes;

      const findAttr = (key: string) => attrs.find((a) => a.key === key);

      expect(findAttr(OTTRIX_ATTRIBUTES.TOOL_NAME)?.value.stringValue).toBe('web_search');
      expect(findAttr(OTTRIX_ATTRIBUTES.TOOL_SIDE_EFFECT)?.value.stringValue).toBe('read');
      expect(findAttr(OTTRIX_ATTRIBUTES.TTFT_MS)?.value.intValue).toBe('234');
      expect(findAttr(OTTRIX_ATTRIBUTES.TOKENS_PER_SECOND)?.value.doubleValue).toBe(85.3);
      expect(findAttr(OTTRIX_ATTRIBUTES.COST_USD)?.value.doubleValue).toBe(0.0045);
    });
  });

  describe('RunContext attributes', () => {
    it('includes RunContext attributes in spans', async () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [createTestSpan({ name: 'agent.run' })],
      });

      const runContext = { runId: 'run_abc123', stepId: 'step_1', agentName: 'researcher' };
      const otlpSpans = exporter.translateTrace(trace, runContext);
      const attrs = otlpSpans[0]!.attributes;

      const findAttr = (key: string) => attrs.find((a) => a.key === key);

      expect(findAttr(OTTRIX_ATTRIBUTES.RUN_ID)?.value.stringValue).toBe('run_abc123');
      expect(findAttr(OTTRIX_ATTRIBUTES.STEP_ID)?.value.stringValue).toBe('step_1');
      expect(findAttr(OTTRIX_ATTRIBUTES.AGENT_NAME)?.value.stringValue).toBe('researcher');
    });

    it('includes RunContext in resource attributes', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        serviceName: 'my-agent',
        fetchImpl: fetchMock,
      });

      const resource = exporter.buildResource({
        runId: 'run_xyz',
        agentName: 'assistant',
      });

      const findAttr = (key: string) => resource.attributes.find((a) => a.key === key);

      expect(findAttr('service.name')?.value.stringValue).toBe('my-agent');
      expect(findAttr(OTTRIX_ATTRIBUTES.RUN_ID)?.value.stringValue).toBe('run_xyz');
      expect(findAttr(OTTRIX_ATTRIBUTES.AGENT_NAME)?.value.stringValue).toBe('assistant');
    });
  });

  describe('cross-linking', () => {
    it('includes langfuse.trace_id when set', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      exporter.setLangfuseTraceId('langfuse-trace-abc123');

      const trace = createTestTrace({
        spans: [createTestSpan({ name: 'agent.run' })],
      });

      const otlpSpans = exporter.translateTrace(trace);
      const attrs = otlpSpans[0]!.attributes;

      const langfuseAttr = attrs.find((a) => a.key === 'langfuse.trace_id');
      expect(langfuseAttr?.value.stringValue).toBe('langfuse-trace-abc123');
    });
  });

  describe('batch export', () => {
    it('buffers spans until batchSize is reached', async () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        batchSize: 3,
        flushIntervalMs: 60_000,
        fetchImpl: fetchMock,
      });

      const trace1 = createTestTrace({ spans: [createTestSpan({ name: 'span1' })] });
      const trace2 = createTestTrace({ spans: [createTestSpan({ name: 'span2' })] });

      await exporter.export(trace1);
      await exporter.export(trace2);

      expect(exporter.bufferSize).toBe(2);
      expect(fetchMock).not.toHaveBeenCalled();

      const trace3 = createTestTrace({ spans: [createTestSpan({ name: 'span3' })] });
      await exporter.export(trace3);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exporter.bufferSize).toBe(0);

      await exporter.shutdown();
    });

    it('flushes on interval', async () => {
      vi.useFakeTimers();

      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        batchSize: 100,
        flushIntervalMs: 1_000,
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({ spans: [createTestSpan()] });
      await exporter.export(trace);

      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      await exporter.shutdown();
    });

    it('sends remaining spans on shutdown', async () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({ spans: [createTestSpan()] });
      await exporter.export(trace);

      expect(fetchMock).not.toHaveBeenCalled();

      await exporter.shutdown();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exporter.isClosed).toBe(true);
    });
  });

  describe('HTTP errors', () => {
    it('retries with backoff on 5xx errors', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return { ok: false, status: 503 };
        }
        return { ok: true, status: 200 };
      });

      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        batchSize: 1,
        maxRetries: 3,
        retryBaseDelayMs: 100,
        fetchImpl: mockFetch,
      });

      const exportPromise = exporter.export(createTestTrace({ spans: [createTestSpan()] }));

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      await exportPromise;

      expect(mockFetch).toHaveBeenCalledTimes(3);

      await exporter.shutdown();
    });

    it('does not retry on 4xx errors', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        batchSize: 1,
        maxRetries: 3,
        fetchImpl: mockFetch,
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));

      expect(mockFetch).toHaveBeenCalledTimes(1);

      await exporter.shutdown();
    });

    it('handles network errors with retry', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Network error');
        }
        return { ok: true, status: 200 };
      });

      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        batchSize: 1,
        maxRetries: 3,
        retryBaseDelayMs: 100,
        fetchImpl: mockFetch,
      });

      const exportPromise = exporter.export(createTestTrace({ spans: [createTestSpan()] }));

      await vi.advanceTimersByTimeAsync(100);
      await exportPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);

      await exporter.shutdown();
    });
  });

  describe('parent-child relationships', () => {
    it('maintains correct parent-child relationships for multiple spans', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [
          createTestSpan({
            spanId: 'root-span-id-123456',
            parentSpanId: undefined,
            name: 'agent.run',
          }),
          createTestSpan({
            spanId: 'child-span-id-789012',
            parentSpanId: 'root-span-id-123456',
            name: 'llm.complete',
          }),
          createTestSpan({
            spanId: 'grandchild-span-345678',
            parentSpanId: 'child-span-id-789012',
            name: 'tool.execute',
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);

      expect(otlpSpans).toHaveLength(3);

      const rootSpan = otlpSpans.find((s) => s.name === 'ottrix.agent.run');
      const childSpan = otlpSpans.find((s) => s.name === 'ottrix.llm.complete');
      const grandchildSpan = otlpSpans.find((s) => s.name === 'ottrix.tool.execute');

      expect(rootSpan?.parentSpanId).toBeUndefined();
      expect(childSpan?.parentSpanId).toBe(rootSpan?.spanId);
      expect(grandchildSpan?.parentSpanId).toBe(childSpan?.spanId);
    });
  });

  describe('OTLP payload structure', () => {
    it('builds correct ExportTraceServiceRequest structure', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        serviceName: 'test-service',
        serviceVersion: '1.0.0',
        resourceAttributes: {
          'deployment.environment': 'production',
        },
        fetchImpl: fetchMock,
      });

      const spans: OtlpSpan[] = [
        {
          traceId: '550e8400e29b41d4a716446655440000',
          spanId: '123e4567e89b12d3',
          name: 'ottrix.agent.run',
          kind: 1,
          startTimeUnixNano: '1700000000000000000',
          endTimeUnixNano: '1700000001000000000',
          attributes: [],
          events: [],
          status: { code: 1 },
        },
      ];

      const payload = exporter.buildExportRequest(
        spans.map((span) => ({ span, runContext: { runId: 'run-1', agentName: 'agent-1' } })),
      );

      expect(payload.resourceSpans).toHaveLength(1);

      const resourceSpans = payload.resourceSpans[0]!;
      const resourceAttrs = resourceSpans.resource.attributes;

      const findAttr = (key: string) => resourceAttrs.find((a) => a.key === key);
      expect(findAttr('service.name')?.value.stringValue).toBe('test-service');
      expect(findAttr('service.version')?.value.stringValue).toBe('1.0.0');
      expect(findAttr('deployment.environment')?.value.stringValue).toBe('production');

      expect(resourceSpans.scopeSpans).toHaveLength(1);
      expect(resourceSpans.scopeSpans[0]?.scope.name).toBe('ottrix');
      expect(resourceSpans.scopeSpans[0]?.spans).toHaveLength(1);
    });

    it('sends correct Content-Type and headers', async () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        headers: {
          'x-api-key': 'test-key',
          Authorization: 'Bearer token',
        },
        batchSize: 1,
        fetchImpl: fetchMock,
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestInit.method).toBe('POST');
      expect(requestInit.headers).toMatchObject({
        'Content-Type': 'application/json',
        'x-api-key': 'test-key',
        Authorization: 'Bearer token',
      });

      await exporter.shutdown();
    });
  });

  describe('createOtelExporter factory', () => {
    it('creates Jaeger exporter with defaults', async () => {
      const exporter = createOtelExporter('jaeger', {});
      expect(exporter).toBeInstanceOf(OtelExporter);
      await exporter.shutdown();
    });

    it('creates Honeycomb exporter with API key header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const exporter = createOtelExporter('honeycomb', {
        apiKey: 'hc-api-key',
        fetchImpl: mockFetch,
        batchSize: 1,
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(requestInit.headers).toMatchObject({
        'x-honeycomb-team': 'hc-api-key',
      });

      await exporter.shutdown();
    });

    it('creates Datadog exporter with API key header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const exporter = createOtelExporter('datadog', {
        apiKey: 'dd-api-key',
        fetchImpl: mockFetch,
        batchSize: 1,
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('datadoghq.com');
      expect(requestInit.headers).toMatchObject({
        'DD-API-KEY': 'dd-api-key',
      });

      await exporter.shutdown();
    });
  });

  describe('error status handling', () => {
    it('sets error status code for error spans', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [
          createTestSpan({
            attributes: {
              status: 'error',
              statusMessage: 'Something went wrong',
            },
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);
      const span = otlpSpans[0]!;

      expect(span.status.code).toBe(2);
      expect(span.status.message).toBe('Something went wrong');
    });
  });

  describe('attribute value types', () => {
    it('correctly converts various attribute types to OTLP format', () => {
      const exporter = new OtelExporter({
        endpoint: 'http://localhost:4318',
        fetchImpl: fetchMock,
      });

      const trace = createTestTrace({
        spans: [
          createTestSpan({
            attributes: {
              stringAttr: 'hello',
              intAttr: 42,
              floatAttr: 3.14,
              boolAttr: true,
              arrayAttr: [1, 2, 3],
              objectAttr: { nested: 'value' },
            },
          }),
        ],
      });

      const otlpSpans = exporter.translateTrace(trace);
      const attrs = otlpSpans[0]!.attributes;

      const findAttr = (key: string) => attrs.find((a) => a.key === key);

      expect(findAttr('stringAttr')?.value.stringValue).toBe('hello');
      expect(findAttr('intAttr')?.value.intValue).toBe('42');
      expect(findAttr('floatAttr')?.value.doubleValue).toBe(3.14);
      expect(findAttr('boolAttr')?.value.boolValue).toBe(true);
      expect(findAttr('arrayAttr')?.value.arrayValue?.values).toHaveLength(3);
      expect(findAttr('objectAttr')?.value.kvlistValue?.values).toHaveLength(1);
    });
  });
});

describe('OtelExporter gRPC validation', () => {
  it('throws error when gRPC protocol is requested', () => {
    expect(
      () =>
        new OtelExporter({
          endpoint: 'http://localhost:4317',
          protocol: 'grpc',
        }),
    ).toThrow('gRPC protocol is not supported');
  });
});

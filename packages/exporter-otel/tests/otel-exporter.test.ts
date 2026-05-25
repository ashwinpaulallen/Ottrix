import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpanData, TraceData } from 'ottrix';
import {
  GEN_AI_ATTRIBUTES,
  OtelExporter,
  OTTRIX_ATTRIBUTES,
  createOtelExporter,
} from '../src/index.js';

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

function toFetchImpl(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

describe('@ottrix/exporter-otel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('translates ottrix spans to correct OTLP JSON', () => {
    const exporter = new OtelExporter({ fetchImpl: toFetchImpl(fetchMock) });
    const trace = createTestTrace({
      spans: [
        createTestSpan({
          parentSpanId: '987fcdeb-51a2-3b4c-d5e6-f78901234567',
          name: 'llm.complete',
          attributes: {
            'llm.model': 'claude-sonnet-4-20250514',
            'llm.input_tokens': 1500,
            status: 'ok',
          },
        }),
      ],
    });

    const [span] = exporter.translateTrace(trace);
    expect(span?.traceId).toHaveLength(32);
    expect(span?.spanId).toHaveLength(16);
    expect(span?.parentSpanId).toHaveLength(16);
    expect(span?.name).toBe('ottrix.llm.complete');
    expect(span?.startTimeUnixNano).toBe('1700000000000000000');
  });

  it('applies GenAI semantic conventions', () => {
    const exporter = new OtelExporter({ fetchImpl: toFetchImpl(fetchMock) });
    const trace = createTestTrace({
      spans: [
        createTestSpan({
          name: 'llm.complete',
          attributes: {
            component: 'anthropic',
            'llm.model': 'claude-sonnet-4-20250514',
            'llm.input_tokens': 1500,
            'llm.output_tokens': 800,
          },
        }),
      ],
    });

    const attrs = exporter.translateTrace(trace)[0]!.attributes;
    const find = (key: string) => attrs.find((entry) => entry.key === key);

    expect(find(GEN_AI_ATTRIBUTES.SYSTEM)?.value.stringValue).toBe('anthropic');
    expect(find(GEN_AI_ATTRIBUTES.REQUEST_MODEL)?.value.stringValue).toBe('claude-sonnet-4-20250514');
    expect(find(GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS)?.value.intValue).toBe('1500');
    expect(find(GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS)?.value.intValue).toBe('800');
  });

  it('applies ottrix-specific attributes', () => {
    const exporter = new OtelExporter({ fetchImpl: toFetchImpl(fetchMock) });
    const trace = createTestTrace({
      spans: [
        createTestSpan({
          name: 'tool.execute',
          attributes: {
            'tool.name': 'web_search',
            'llm.cost_usd': 0.0045,
            'llm.ttft_ms': 234,
          },
        }),
      ],
    });

    const attrs = exporter.translateTrace(trace, {
      runId: 'run-1',
      agentName: 'assistant',
    })[0]!.attributes;
    const find = (key: string) => attrs.find((entry) => entry.key === key);

    expect(find(OTTRIX_ATTRIBUTES.RUN_ID)?.value.stringValue).toBe('run-1');
    expect(find(OTTRIX_ATTRIBUTES.AGENT_NAME)?.value.stringValue).toBe('assistant');
    expect(find(OTTRIX_ATTRIBUTES.TOOL_NAME)?.value.stringValue).toBe('web_search');
    expect(find(OTTRIX_ATTRIBUTES.COST_USD)?.value.doubleValue).toBe(0.0045);
    expect(find(OTTRIX_ATTRIBUTES.TTFT_MS)?.value.intValue).toBe('234');
  });

  describe('batching', () => {
    it('flushes at batch size', async () => {
      const exporter = new OtelExporter({
        batchSize: 2,
        flushIntervalMs: 60_000,
        fetchImpl: toFetchImpl(fetchMock),
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan({ name: 'a' })] }));
      expect(fetchMock).not.toHaveBeenCalled();

      await exporter.export(createTestTrace({ spans: [createTestSpan({ name: 'b' })] }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exporter.bufferSize).toBe(0);

      await exporter.shutdown();
    });

    it('flushes on interval', async () => {
      vi.useFakeTimers();
      const exporter = new OtelExporter({
        batchSize: 100,
        flushIntervalMs: 1_000,
        fetchImpl: toFetchImpl(fetchMock),
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await exporter.shutdown();
    });

    it('flushes remaining spans on shutdown', async () => {
      const exporter = new OtelExporter({
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetchImpl: toFetchImpl(fetchMock),
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));
      expect(fetchMock).not.toHaveBeenCalled();

      await exporter.shutdown();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exporter.isClosed).toBe(true);
    });
  });

  describe('HTTP retry', () => {
    it('retries on 5xx errors', async () => {
      vi.useFakeTimers();
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) return { ok: false, status: 503 };
        return { ok: true, status: 200 };
      });

      const exporter = new OtelExporter({
        batchSize: 1,
        maxRetries: 3,
        retryBaseDelayMs: 100,
        fetchImpl: toFetchImpl(mockFetch),
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
        batchSize: 1,
        maxRetries: 3,
        fetchImpl: toFetchImpl(mockFetch),
      });

      await exporter.export(createTestTrace({ spans: [createTestSpan()] }));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await exporter.shutdown();
    });
  });

  describe('createOtelExporter', () => {
    it('creates exporter with backend defaults', async () => {
      const exporter = createOtelExporter('tempo', {});
      expect(exporter).toBeInstanceOf(OtelExporter);
      await exporter.shutdown();
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceData } from 'ottrix';
import { LangfuseExporter } from '../src/index.js';

interface LangfuseBatchEvent {
  type: string;
  body: Record<string, unknown>;
}

interface LangfuseIngestionBody {
  batch: LangfuseBatchEvent[];
}

function sampleTrace(overrides: Partial<TraceData> = {}): TraceData {
  const start = Date.now() - 100;
  return {
    traceId: 'trace-1',
    name: 'agent.run',
    startTime: start,
    endTime: start + 100,
    status: 'ok',
    attributes: { 'agent.name': 'test' },
    spans: [
      {
        spanId: 'span-llm',
        parentSpanId: 'span-root',
        name: 'llm.complete',
        startTime: start + 10,
        endTime: start + 80,
        attributes: {
          'llm.model': 'mock-model',
          'llm.input_tokens': 10,
          'llm.output_tokens': 5,
          'llm.total_tokens': 15,
          'llm.ttft_ms': 12,
          'llm.total_ms': 70,
          'llm.cost_usd': 0.0042,
        },
        events: [],
      },
      {
        spanId: 'span-tool',
        parentSpanId: 'span-root',
        name: 'tool.execute',
        startTime: start + 20,
        endTime: start + 40,
        attributes: { 'tool.name': 'echo' },
        events: [],
      },
    ],
    metadata: {},
    input: 'hello',
    output: 'world',
    ...overrides,
  };
}

describe('@ottrix/exporter-langfuse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps TraceData to Langfuse ingestion format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new LangfuseExporter({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://langfuse.test',
      flushInterval: 60_000,
      batchSize: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    await exporter.export(sampleTrace());
    await exporter.shutdown();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://langfuse.test/api/public/ingestion');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('pk:sk').toString('base64')}`,
    );

    const body = JSON.parse(String(init.body)) as LangfuseIngestionBody;
    expect(body.batch).toHaveLength(3);

    const traceEvent = body.batch.find((event) => event.type === 'trace-create');
    expect(traceEvent?.body.id).toBe('trace-1');
    expect(traceEvent?.body.input).toBe('hello');
    expect(traceEvent?.body.output).toBe('world');

    const generation = body.batch.find((event) => event.type === 'generation-create');
    expect(generation?.body.traceId).toBe('trace-1');
    expect(generation?.body.model).toBe('mock-model');
    expect(generation?.body.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect((generation?.body.metadata as { ttft_ms: number }).ttft_ms).toBe(12);
    expect((generation?.body.metadata as { cost_usd: number }).cost_usd).toBe(0.0042);

    const spanEvent = body.batch.find((event) => event.type === 'span-create');
    expect(spanEvent?.body.name).toBe('tool.execute');
  });

  it('flushes buffered traces on interval', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new LangfuseExporter({
      publicKey: 'pk',
      secretKey: 'sk',
      flushInterval: 1_000,
      batchSize: 100,
      fetchImpl: fetchMock as typeof fetch,
    });

    await exporter.export(sampleTrace());
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await exporter.shutdown();
  });

  it('flushes at batch size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new LangfuseExporter({
      publicKey: 'pk',
      secretKey: 'sk',
      flushInterval: 60_000,
      batchSize: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    await exporter.export(sampleTrace());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await exporter.shutdown();
  });

  it('handles auth errors without re-buffering', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const exporter = new LangfuseExporter({
      publicKey: 'pk',
      secretKey: 'sk',
      batchSize: 1,
      flushInterval: 60_000,
      fetchImpl: fetchMock as typeof fetch,
    });

    await exporter.export(sampleTrace());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exporter.bufferSize).toBe(0);

    await exporter.shutdown();
  });
});

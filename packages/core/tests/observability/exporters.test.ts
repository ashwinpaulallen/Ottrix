import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { instrumentProvider } from '../../src/observability/instrument.js';
import {
  InMemoryTraceExporter,
  LangfuseExporter,
  MultiExporter,
  TraceConsoleExporter,
  WebhookExporter,
  type TraceData,
} from '../../src/observability/exporters/index.js';
import { Telemetry } from '../../src/observability/telemetry.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

interface FetchCallInit extends RequestInit {
  body?: RequestInit['body'];
}

interface LangfuseBatchEvent {
  type: string;
  body: Record<string, unknown>;
}

interface LangfuseIngestionBody {
  batch: LangfuseBatchEvent[];
}

interface WebhookPayloadItem {
  traceId: string;
}

function parseJsonBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') {
    throw new Error('Expected fetch body to be a JSON string');
  }
  return JSON.parse(body);
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

describe('LangfuseExporter', () => {
  it('maps TraceData to Langfuse ingestion format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new LangfuseExporter({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://langfuse.test',
      flushIntervalMs: 60_000,
      batchSize: 1,
      fetchImpl: fetchMock,
    });

    await exporter.export(sampleTrace());
    await exporter.shutdown();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchCallInit];
    expect(url).toBe('https://langfuse.test/api/public/ingestion');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('pk:sk').toString('base64')}`,
    );

    const body = parseJsonBody(init.body) as LangfuseIngestionBody;
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

    const spanEvent = body.batch.find((event) => event.type === 'span-create');
    expect(spanEvent?.body.name).toBe('tool.execute');
  });

  it('flushes buffered traces on interval', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new LangfuseExporter({
      publicKey: 'pk',
      secretKey: 'sk',
      flushIntervalMs: 1_000,
      batchSize: 100,
      fetchImpl: fetchMock,
    });

    await exporter.export(sampleTrace());
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await exporter.shutdown();
    vi.useRealTimers();
  });
});

describe('WebhookExporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts batched traces as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const exporter = new WebhookExporter({
      url: 'https://hooks.test/traces',
      batchSize: 2,
      flushIntervalMs: 60_000,
      fetchImpl: fetchMock,
    });

    await exporter.export(sampleTrace({ traceId: 'a' }));
    expect(fetchMock).not.toHaveBeenCalled();

    await exporter.export(sampleTrace({ traceId: 'b' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, FetchCallInit];
    const payload = parseJsonBody(init.body) as WebhookPayloadItem[];
    expect(payload).toHaveLength(2);
    expect(payload[0]?.traceId).toBe('a');
    expect(payload[1]?.traceId).toBe('b');
  });

  it('retries with backoff on failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const exporter = new WebhookExporter({
      url: 'https://hooks.test/traces',
      batchSize: 1,
      initialBackoffMs: 100,
      flushIntervalMs: 60_000,
      fetchImpl: fetchMock,
    });

    const exportPromise = exporter.export(sampleTrace());
    await vi.advanceTimersByTimeAsync(1_000);
    await exportPromise;

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('re-queues traces when delivery keeps failing with 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const exporter = new WebhookExporter({
      url: 'https://hooks.test/traces',
      batchSize: 1,
      maxRetries: 0,
      initialBackoffMs: 10,
      flushIntervalMs: 60_000,
      fetchImpl: fetchMock,
    });

    await exporter.export(sampleTrace());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await exporter.export(sampleTrace({ traceId: 'retry' }));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('MultiExporter', () => {
  it('fans out to all exporters and isolates failures', async () => {
    const memory = new InMemoryTraceExporter();
    const failing: import('../../src/observability/exporters/types.js').TraceExporter = {
      name: 'failing',
      export: async () => {
        throw new Error('boom');
      },
      flush: async () => {},
      shutdown: async () => {},
    };

    const multi = new MultiExporter([failing, memory]);
    await multi.export(sampleTrace());

    expect(memory.traces).toHaveLength(1);
    expect(memory.traces[0]?.traceId).toBe('trace-1');
  });
});

describe('TraceConsoleExporter', () => {
  it('does not throw when exporting', async () => {
    const exporter = new TraceConsoleExporter();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await expect(exporter.export(sampleTrace())).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalled();

    infoSpy.mockRestore();
  });
});

describe('Telemetry trace export integration', () => {
  it('exports a complete trace when the root span ends', async () => {
    const traceExporter = new InMemoryTraceExporter();
    const spanExporter = new (await import('../../src/observability/telemetry.js')).InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [spanExporter] });
    telemetry.setExporter(traceExporter);

    const tool = new FunctionTool({
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (input: Record<string, unknown>) => (typeof input.text === 'string' ? input.text : ''),
    });

    const registry = new ToolRegistry({ telemetry, component: 'test-tools' });
    registry.register(tool);

    const provider = instrumentProvider(
      new MockCompletionProvider()
        .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'echo', input: { text: 'hi' } }], usage))
        .enqueue(textCompletion('done', usage)),
      telemetry,
    );

    const agent = new Agent({
      name: 'researcher',
      provider,
      toolRegistry: registry,
      telemetry,
    });

    await agent.run('test prompt');

    expect(traceExporter.traces).toHaveLength(1);
    const trace = traceExporter.traces[0]!;
    expect(trace.name).toBe('agent.run');
    expect(trace.input).toBe('test prompt');
    expect(trace.output).toBe('done');
    expect(trace.spans.some((span) => span.name === 'llm.complete')).toBe(true);
    expect(trace.spans.some((span) => span.name === 'tool.execute')).toBe(true);
  });
});

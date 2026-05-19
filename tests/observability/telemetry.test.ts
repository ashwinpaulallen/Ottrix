import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import {
  instrumentProvider,
  isInstrumentedProvider,
} from '../../src/observability/instrument.js';
import { RunRecorder } from '../../src/observability/replay.js';
import { Telemetry, InMemoryExporter } from '../../src/observability/telemetry.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe('Telemetry spans', () => {
  it('nests spans and captures timing', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });

    const root = telemetry.startSpan('parent');
    await telemetry.withActiveSpan(root, async () => {
      const child = telemetry.startSpan('child', { key: 'value' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      child.setStatus('ok');
      child.end();
    });
    root.end();

    expect(exporter.spans).toHaveLength(2);

    const parent = exporter.spans.find((s) => s.name === 'parent');
    const child = exporter.spans.find((s) => s.name === 'child');

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.parentSpanId).toBe(parent?.spanId);
    expect(parent?.traceId).toBe(child?.traceId);
    expect(child?.durationMs).toBeGreaterThan(0);
    expect(child?.attributes.key).toBe('value');
  });

  it('records counters and histograms', () => {
    const telemetry = new Telemetry();
    telemetry.counter('requests').add(2);
    telemetry.histogram('latency_ms').record(12);
    telemetry.histogram('latency_ms').record(30);
    telemetry.gauge('active').set(3);

    expect(telemetry.counter('requests').get()).toBe(2);
    expect(telemetry.histogram('latency_ms').getValues()).toEqual([12, 30]);
    expect(telemetry.gauge('active').get()).toBe(3);
    expect(telemetry.metricPoints.length).toBeGreaterThan(0);
  });

  it('uses stable metric keys regardless of attribute order', () => {
    const telemetry = new Telemetry();
    telemetry.counter('hits', { b: 1, a: 2 }).add(1);
    telemetry.counter('hits', { a: 2, b: 1 }).add(1);
    expect(telemetry.counter('hits', { b: 1, a: 2 }).get()).toBe(2);
  });

  it('isolates finished spans per run via getFinishedSpansSince', async () => {
    const telemetry = new Telemetry();
    const first = telemetry.startSpan('run.one');
    first.end();
    const start = telemetry.finishedSpans.length;

    const second = telemetry.startSpan('run.two');
    second.end();

    expect(telemetry.getFinishedSpansSince(0)).toHaveLength(2);
    expect(telemetry.getFinishedSpansSince(start)).toHaveLength(1);
    expect(telemetry.getFinishedSpansSince(start)[0]?.name).toBe('run.two');
  });

  it('does not double-wrap an instrumented provider', () => {
    const telemetry = new Telemetry();
    const provider = new MockCompletionProvider().enqueue(textCompletion('ok', usage));
    const wrapped = instrumentProvider(provider, telemetry);
    const again = instrumentProvider(wrapped, telemetry);
    expect(isInstrumentedProvider(wrapped)).toBe(true);
    expect(again).toBe(wrapped);
  });
});

describe('Agent telemetry integration', () => {
  it('creates nested agent, llm, and tool spans', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });

    const tool = new FunctionTool({
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (input) => {
        const text = input.text;
        return typeof text === 'string' ? text : '';
      },
    });

    const registry = new ToolRegistry({ telemetry, component: 'test-tools' });
    registry.register(tool);

    const providerRegistry = new ProviderRegistry({ telemetry });
    providerRegistry.register(
      'mock',
      new MockCompletionProvider()
        .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'echo', input: { text: 'hi' } }], usage))
        .enqueue(textCompletion('done', usage)),
    );
    providerRegistry.setDefault('mock');

    const agent = new Agent({
      name: 'researcher',
      provider: providerRegistry,
      toolRegistry: registry,
      telemetry,
    });

    await agent.run('test');

    const names = exporter.spans.map((s) => s.name);
    expect(names).toContain('agent.run');
    expect(names).toContain('llm.complete');
    expect(names).toContain('tool.execute');

    const agentSpan = exporter.spans.find((s) => s.name === 'agent.run');
    const llmSpan = exporter.spans.find((s) => s.name === 'llm.complete');
    const toolSpan = exporter.spans.find((s) => s.name === 'tool.execute');

    expect(llmSpan?.parentSpanId).toBe(agentSpan?.spanId);
    expect(toolSpan?.parentSpanId).toBe(agentSpan?.spanId);
    expect(llmSpan?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records only spans from each run in RunRecorder', async () => {
    const telemetry = new Telemetry();
    const recorder = new RunRecorder();

    const provider = new MockCompletionProvider()
      .enqueue(textCompletion('a', usage))
      .enqueue(textCompletion('b', usage));

    const agent = new Agent({
      name: 'rec',
      provider,
      telemetry,
      runRecorder: recorder,
    });

    await agent.run('first');
    const first = recorder.getRuns()[0]!;
    const firstSpanIds = new Set(first.spans.map((s) => s.spanId));

    await agent.run('second');
    const second = recorder.getLatestRun()!;

    expect(second.spans.length).toBeGreaterThan(0);
    const leaked = second.spans.filter((s) => firstSpanIds.has(s.spanId));
    expect(leaked).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { CompletionParams, CompletionResult } from '../../src/types/provider.js';
import { instrumentProvider } from '../../src/observability/instrument.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';
import { computeCompletionLatency } from '../../src/providers/latency.js';

describe('instrumentProvider latency attributes', () => {
  it('attaches latency metrics to llm.complete spans', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const provider = instrumentProvider(
      {
        async complete(_params: CompletionParams): Promise<CompletionResult> {
          return {
            content: [{ type: 'text', text: 'ok' }],
            model: 'mock',
            usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
            stopReason: 'stop',
            latency: computeCompletionLatency({
              ttftMs: 120,
              totalTimeMs: 450,
              outputTokens: 7,
            }),
          };
        },
        stream: async function* () {
          yield {
            type: 'done',
            data: {
              stopReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              latency: computeCompletionLatency({
                ttftMs: 50,
                totalTimeMs: 200,
                outputTokens: 1,
              }),
            },
          };
        },
        countTokens: async () => 1,
      },
      telemetry,
    );

    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });

    const span = exporter.spans.find((entry) => entry.name === 'llm.complete');
    expect(span?.attributes['llm.ttft_ms']).toBe(120);
    expect(span?.attributes['llm.total_ms']).toBe(450);
    expect(span?.attributes['llm.tokens_per_second']).toBeCloseTo(7 / 0.45, 5);
  });

  it('attaches latency metrics to llm.stream spans from the done chunk', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });

    const provider = instrumentProvider(
      {
        complete: async () => {
          throw new Error('not used');
        },
        stream: async function* () {
          yield { type: 'text_delta', data: { text: 'hi' } };
          yield {
            type: 'done',
            data: {
              stopReason: 'stop',
              usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
              latency: computeCompletionLatency({
                ttftMs: 30,
                totalTimeMs: 180,
                outputTokens: 4,
              }),
            },
          };
        },
        countTokens: async () => 1,
      },
      telemetry,
    );

    for await (const _chunk of provider.stream({ messages: [{ role: 'user', content: 'hello' }] })) {
      // drain stream
    }

    const span = exporter.spans.find((entry) => entry.name === 'llm.stream');
    expect(span?.attributes['llm.ttft_ms']).toBe(30);
    expect(span?.attributes['llm.total_ms']).toBe(180);
    expect(span?.attributes['llm.tokens_per_second']).toBeCloseTo(4 / 0.18, 5);
  });

  it('records token histograms for llm.stream spans', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });

    const provider = instrumentProvider(
      {
        complete: async () => {
          throw new Error('not used');
        },
        stream: async function* () {
          yield {
            type: 'done',
            data: {
              stopReason: 'stop',
              usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
              latency: computeCompletionLatency({
                ttftMs: 30,
                totalTimeMs: 180,
                outputTokens: 4,
              }),
            },
          };
        },
        countTokens: async () => 1,
      },
      telemetry,
    );

    for await (const _chunk of provider.stream({ messages: [{ role: 'user', content: 'hello' }] })) {
      // drain stream
    }

    const inputTokens = exporter.metrics.filter(
      (point) => point.name === 'llm.tokens' && point.attributes?.kind === 'input',
    );
    const outputTokens = exporter.metrics.filter(
      (point) => point.name === 'llm.tokens' && point.attributes?.kind === 'output',
    );

    expect(inputTokens.some((point) => point.value === 2)).toBe(true);
    expect(outputTokens.some((point) => point.value === 4)).toBe(true);
  });
});

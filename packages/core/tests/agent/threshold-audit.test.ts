import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import {
  AuditEmitter,
  HmacSigner,
  InMemorySink,
  resetAudit,
  useAudit,
  type AuditEvent,
} from '../../src/guardrails/audit.js';
import { resetGlobalObservability } from '../../src/observability/global.js';
import {
  createTokenPricing,
  useTokenPricing,
} from '../../src/observability/token-accounting/cost-attribution.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';
import type { TokenUsage } from '../../src/types/provider.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function thresholdEvents(sink: InMemorySink): AuditEvent[] {
  return sink.getEvents().filter((event) => event.action === 'threshold_exceeded');
}

function waitForThresholds(
  sink: InMemorySink,
  count: number,
  timeoutMs = 2_000,
): Promise<AuditEvent[]> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      const events = thresholdEvents(sink);
      if (events.length >= count) {
        resolve(events);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${count} threshold events (got ${events.length})`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function waitForRunEnd(sink: InMemorySink): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (sink.getEvents().some((event) => event.type === 'agent.run.end')) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for agent.run.end');
}

describe('usage threshold audit events', () => {
  let sink: InMemorySink;

  beforeEach(() => {
    resetGlobalObservability();
    resetAudit();
    useTokenPricing(undefined);
    sink = new InMemorySink();
    useAudit(new AuditEmitter({ sink }));
  });

  afterEach(() => {
    resetAudit();
    useTokenPricing(undefined);
    resetGlobalObservability();
  });

  it('emits no threshold events when thresholds are omitted', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('finished', usage));
    const agent = new Agent({ name: 'no-thresholds', provider, maxSteps: 2 });

    await agent.run('hello');
    await waitForRunEnd(sink);

    expect(thresholdEvents(sink)).toHaveLength(0);
  });

  it('emits no threshold event when total tokens stay at or below the threshold', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('finished', usage));
    const agent = new Agent({
      name: 'under-threshold',
      provider,
      maxSteps: 2,
      thresholds: { warnTotalTokens: 15 },
    });

    await agent.run('hello');
    await waitForRunEnd(sink);

    expect(thresholdEvents(sink)).toHaveLength(0);
  });

  it('emits a budget.warn event when total tokens exceed the threshold', async () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const provider = new MockCompletionProvider().enqueue(textCompletion('finished', usage));
    const agent = new Agent({
      name: 'over-threshold',
      provider,
      maxSteps: 2,
      telemetry,
      thresholds: { warnTotalTokens: 10 },
    });

    await agent.run('hello');
    const events = await waitForThresholds(sink, 1);
    const event = events[0]!;

    expect(event.type).toBe('budget.warn');
    expect(event.actor).toEqual({ type: 'system', id: 'ottrix' });
    expect(event.action).toBe('threshold_exceeded');
    expect(event.resource).toBe('agent:over-threshold');
    expect(event.outcome).toBe('success');
    expect(event.payload).toMatchObject({
      threshold: { metric: 'totalTokens', configured: 10, actual: 15 },
      agentName: 'over-threshold',
    });
    expect(event.payload?.runId).toEqual(expect.any(String));

    const root = exporter.spans.find((span) => span.name === 'agent.run');
    expect(root?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'budget.warn',
          attributes: {
            'threshold.metric': 'totalTokens',
            'threshold.configured': 10,
            'threshold.actual': 15,
          },
        }),
      ]),
    );
  });

  it('emits one audit event per exceeded threshold', async () => {
    useTokenPricing(createTokenPricing({ inputPer1kTokens: 1, outputPer1kTokens: 1 }));
    const provider = new MockCompletionProvider().enqueue(textCompletion('finished', usage));
    const agent = new Agent({
      name: 'multi-threshold',
      provider,
      maxSteps: 2,
      defaultModel: 'mock-model',
      thresholds: {
        warnInputTokens: 1,
        warnOutputTokens: 1,
        warnTotalTokens: 1,
        warnCostUsd: 0,
        warnLlmCalls: 0,
      },
    });

    await agent.run('hello');
    const events = await waitForThresholds(sink, 5);
    const metrics = events.map((event) => (event.payload?.threshold as { metric: string }).metric);

    expect(metrics).toEqual(['inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'llmCalls']);
    expect(events).toHaveLength(5);
  });

  it('leaves the run result unchanged when thresholds are exceeded', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('finished', usage));
    const agent = new Agent({
      name: 'observational',
      provider,
      maxSteps: 2,
      thresholds: { warnTotalTokens: 1, warnLlmCalls: 0 },
    });

    const result = await agent.run('hello');
    await waitForThresholds(sink, 2);

    expect(result.response).toBe('finished');
    expect(result.metadata.stopReason).toBe('completed');
    expect(result.metadata.warning).toBeUndefined();
    expect(result.totalTokens.totalTokens).toBe(15);
  });

  it('signs threshold events when an AuditSigner is configured', async () => {
    const signedSink = new InMemorySink();
    const signer = new HmacSigner({ secret: 'threshold-secret' });
    useAudit(new AuditEmitter({ sink: signedSink, signer }));

    const provider = new MockCompletionProvider().enqueue(textCompletion('finished', usage));
    const agent = new Agent({
      name: 'signed-threshold',
      provider,
      maxSteps: 2,
      thresholds: { warnTotalTokens: 10 },
    });

    await agent.run('hello');
    const events = await waitForThresholds(signedSink, 1);
    const event = events[0]!;

    expect(event.signature).toBeTruthy();
    expect(signer.verify(event)).toBe(true);
  });
});

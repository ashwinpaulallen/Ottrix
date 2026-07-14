import { describe, expect, it } from 'vitest';

import {
  enterCapabilityScope,
  getTokenAccumulator,
  recordTokens,
  withCapabilityScope,
  withTokenAccounting,
} from '../../../src/observability/token-accounting/context.js';
import { CAPABILITY } from '../../../src/observability/token-accounting/types.js';

describe('token accounting context (ALS)', () => {
  it('withTokenAccounting: accumulator is accessible inside fn', async () => {
    await withTokenAccounting('run-1', async (acc) => {
      expect(getTokenAccumulator()).toBe(acc);
      expect(acc.getBreakdown().runId).toBe('run-1');
    });
  });

  it('getTokenAccumulator outside of withTokenAccounting: returns undefined', () => {
    expect(getTokenAccumulator()).toBeUndefined();
  });

  it('recordTokens with active accumulator: records correctly', async () => {
    await withTokenAccounting('run-3', async (acc) => {
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        recordTokens({ inputTokens: 12, outputTokens: 4 });
      });

      const breakdown = acc.getBreakdown();
      expect(breakdown.totalInputTokens).toBe(12);
      expect(breakdown.totalOutputTokens).toBe(4);
      expect(breakdown.byCapability[CAPABILITY.LLM]?.calls).toBe(1);
    });
  });

  it('recordTokens without active accumulator: no-op (no throw)', () => {
    expect(() => recordTokens({ inputTokens: 1, outputTokens: 1 })).not.toThrow();
    expect(getTokenAccumulator()).toBeUndefined();
  });

  it('enterCapabilityScope: returns a working cleanup function', async () => {
    await withTokenAccounting('run-5', async (acc) => {
      const exit = enterCapabilityScope(CAPABILITY.EVALUATION);
      expect(acc.getCurrentScope()).toBe(CAPABILITY.EVALUATION);

      recordTokens({ inputTokens: 5, outputTokens: 2 });
      exit();

      expect(acc.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);
      expect(acc.getBreakdown().byCapability[CAPABILITY.EVALUATION]?.inputTokens).toBe(5);
    });
  });

  it('withCapabilityScope with no accumulator: runs fn anyway (no crash)', async () => {
    const value = await withCapabilityScope(CAPABILITY.LLM, async () => 'ok');
    expect(value).toBe('ok');
    expect(getTokenAccumulator()).toBeUndefined();
  });

  it('nested withTokenAccounting: inner run has its OWN accumulator', async () => {
    await withTokenAccounting('outer', async (outer) => {
      recordTokens({ inputTokens: 100, outputTokens: 10 });

      await withTokenAccounting('inner', async (inner) => {
        expect(getTokenAccumulator()).toBe(inner);
        expect(inner).not.toBe(outer);
        recordTokens({ inputTokens: 3, outputTokens: 1 });

        expect(inner.getBreakdown().totalInputTokens).toBe(3);
        expect(outer.getBreakdown().totalInputTokens).toBe(100);
      });

      expect(getTokenAccumulator()).toBe(outer);
      expect(outer.getBreakdown().totalInputTokens).toBe(100);
    });
  });

  it('parallel runs: each has independent accumulator (ALS isolation)', async () => {
    const results = await Promise.all([
      withTokenAccounting('parallel-a', async (acc) => {
        await withCapabilityScope(CAPABILITY.LLM, async () => {
          await new Promise((r) => setTimeout(r, 10));
          recordTokens({ inputTokens: 50, outputTokens: 5 });
          expect(getTokenAccumulator()).toBe(acc);
        });
        return acc.getBreakdown();
      }),
      withTokenAccounting('parallel-b', async (acc) => {
        await withCapabilityScope(CAPABILITY.EVALUATION, async () => {
          await new Promise((r) => setTimeout(r, 10));
          recordTokens({ inputTokens: 7, outputTokens: 3 });
          expect(getTokenAccumulator()).toBe(acc);
        });
        return acc.getBreakdown();
      }),
    ]);

    const [a, b] = results;
    expect(a!.runId).toBe('parallel-a');
    expect(b!.runId).toBe('parallel-b');
    expect(a!.totalInputTokens).toBe(50);
    expect(b!.totalInputTokens).toBe(7);
    expect(a!.byCapability[CAPABILITY.LLM]).toBeDefined();
    expect(a!.byCapability[CAPABILITY.EVALUATION]).toBeUndefined();
    expect(b!.byCapability[CAPABILITY.EVALUATION]).toBeDefined();
    expect(b!.byCapability[CAPABILITY.LLM]).toBeUndefined();
  });
});

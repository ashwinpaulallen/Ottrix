import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runWith } from '../../src/context/run-context.js';
import { Telemetry } from '../../src/observability/telemetry.js';
import {
  computeIdempotencyKey,
  generateDefaultIdempotencyKey,
  InMemoryIdempotencyStore,
  resetIdempotencyStore,
  useIdempotencyStore,
} from '../../src/tools/idempotency.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createTool } from '../../src/tools/zod-tool.js';
import { canonicalStringify, sha256 } from '../../src/utils/hash.js';

describe('hash utilities', () => {
  it('canonicalStringify produces stable key order', () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe(canonicalStringify({ a: 1, b: 2 }));
  });

  it('sha256 returns a hex digest', () => {
    expect(sha256('hello')).toHaveLength(64);
  });
});

describe('default idempotency key generation', () => {
  it('produces consistent keys for the same inputs', async () => {
    await runWith({ runId: 'run-1', stepId: 'step-a' }, async () => {
      const first = generateDefaultIdempotencyKey('deploy', { env: 'prod' });
      const second = generateDefaultIdempotencyKey('deploy', { env: 'prod' });
      expect(first).toBe(second);
    });
  });

  it('includes runId and stepId from RunContext', async () => {
    let keyA = '';
    let keyB = '';

    await runWith({ runId: 'run-1', stepId: 'step-a' }, async () => {
      keyA = generateDefaultIdempotencyKey('deploy', { env: 'prod' });
    });
    await runWith({ runId: 'run-2', stepId: 'step-a' }, async () => {
      keyB = generateDefaultIdempotencyKey('deploy', { env: 'prod' });
    });

    expect(keyA).not.toBe(keyB);
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('tracks fresh, done, and fail transitions', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.begin('key-1')).toEqual({ status: 'fresh' });
    await store.complete('key-1', { ok: true });
    expect(await store.begin('key-1')).toEqual({ status: 'done', result: { ok: true } });
    await store.fail('key-1', new Error('retry'));
    expect(await store.begin('key-1')).toEqual({ status: 'fresh' });
  });

  it('expires entries after ttlMs', async () => {
    vi.useFakeTimers();
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    expect(await store.begin('ttl-key')).toEqual({ status: 'fresh' });
    await store.complete('ttl-key', { ok: true });

    vi.advanceTimersByTime(1_001);
    expect(await store.begin('ttl-key')).toEqual({ status: 'fresh' });

    vi.useRealTimers();
  });
});

describe('ToolRegistry idempotency', () => {
  afterEach(() => {
    resetIdempotencyStore();
    vi.useRealTimers();
  });

  it('executes once and returns cached result on repeat calls', async () => {
    const store = new InMemoryIdempotencyStore();
    useIdempotencyStore(store);
    const registry = new ToolRegistry({ idempotencyStore: store });
    let calls = 0;

    registry.register(
      createTool({
        name: 'gh_open_pr',
        description: 'Open a PR',
        input: z.object({ title: z.string() }),
        idempotent: true,
        execute: async ({ title }) => {
          calls += 1;
          return { url: `https://github.com/pr/${title}` };
        },
      }),
    );

    await runWith({ runId: 'run-1', stepId: 'tool-step' }, async () => {
      const first = await registry.execute('gh_open_pr', { title: 'Feature' });
      const second = await registry.execute('gh_open_pr', { title: 'Feature' });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(first.output).toEqual(second.output);
    });

    expect(calls).toBe(1);
  });

  it('uses different keys for different args', async () => {
    const store = new InMemoryIdempotencyStore();
    const registry = new ToolRegistry({ idempotencyStore: store });
    let calls = 0;

    registry.register(
      createTool({
        name: 'deploy',
        description: 'Deploy',
        input: z.object({ env: z.string() }),
        idempotent: true,
        execute: async ({ env }) => {
          calls += 1;
          return { env };
        },
      }),
    );

    await runWith({ runId: 'run-1', stepId: 'step-a' }, async () => {
      await registry.execute('deploy', { env: 'staging' });
      await registry.execute('deploy', { env: 'production' });
    });

    expect(calls).toBe(2);
  });

  it('uses different keys for different runIds', async () => {
    const store = new InMemoryIdempotencyStore();
    const registry = new ToolRegistry({ idempotencyStore: store });
    let calls = 0;

    registry.register(
      createTool({
        name: 'deploy',
        description: 'Deploy',
        input: z.object({ env: z.string() }),
        idempotent: true,
        execute: async () => {
          calls += 1;
          return 'ok';
        },
      }),
    );

    await runWith({ runId: 'run-1', stepId: 'step-a' }, async () => {
      await registry.execute('deploy', { env: 'prod' });
    });
    await runWith({ runId: 'run-2', stepId: 'step-a' }, async () => {
      await registry.execute('deploy', { env: 'prod' });
    });

    expect(calls).toBe(2);
  });

  it('does not apply idempotency to non-idempotent tools', async () => {
    const store = new InMemoryIdempotencyStore();
    const registry = new ToolRegistry({ idempotencyStore: store });
    let calls = 0;

    registry.register(
      createTool({
        name: 'read_file',
        description: 'Read',
        input: z.object({ path: z.string() }),
        execute: async ({ path }) => {
          calls += 1;
          return path;
        },
      }),
    );

    await registry.execute('read_file', { path: '/tmp/a' });
    await registry.execute('read_file', { path: '/tmp/a' });

    expect(calls).toBe(2);
  });

  it('allows retry after a failed execution', async () => {
    const store = new InMemoryIdempotencyStore();
    const registry = new ToolRegistry({ idempotencyStore: store });
    let calls = 0;

    registry.register(
      createTool({
        name: 'deploy',
        description: 'Deploy',
        input: z.object({ env: z.string() }),
        idempotent: true,
        execute: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('transient');
          }
          return 'ok';
        },
      }),
    );

    await runWith({ runId: 'run-1', stepId: 'step-a' }, async () => {
      const failed = await registry.execute('deploy', { env: 'prod' });
      expect(failed.success).toBe(false);

      const success = await registry.execute('deploy', { env: 'prod' });
      expect(success.success).toBe(true);
      expect(success.output).toBe('ok');
    });

    expect(calls).toBe(2);
  });

  it('supports custom idempotency keys', async () => {
    const store = new InMemoryIdempotencyStore();
    const registry = new ToolRegistry({ idempotencyStore: store });
    let calls = 0;

    registry.register(
      createTool({
        name: 'custom_key_tool',
        description: 'Custom key',
        input: z.object({ value: z.string() }),
        idempotent: true,
        idempotencyKey: ({ args, toolName }) =>
          sha256(canonicalStringify([toolName, 'static-scope', args.value])),
        execute: async ({ value }) => {
          calls += 1;
          return value;
        },
      }),
    );

    await runWith({ runId: 'run-1', stepId: 'step-a' }, async () => {
      await registry.execute('custom_key_tool', { value: 'a' });
    });
    await runWith({ runId: 'run-2', stepId: 'step-b' }, async () => {
      await registry.execute('custom_key_tool', { value: 'a' });
    });

    expect(calls).toBe(1);
  });

  it('emits telemetry when an idempotency hit occurs', async () => {
    const store = new InMemoryIdempotencyStore();
    const telemetry = new Telemetry();
    const registry = new ToolRegistry({ idempotencyStore: store, telemetry });
    const start = telemetry.finishedSpans.length;

    registry.register(
      createTool({
        name: 'cached_tool',
        description: 'Cached',
        input: z.object({ id: z.string() }),
        idempotent: true,
        execute: async ({ id }) => id,
      }),
    );

    await runWith({ runId: 'run-telemetry', stepId: 'step-a' }, async () => {
      await registry.execute('cached_tool', { id: '42' });
      await registry.execute('cached_tool', { id: '42' });
    });

    const toolSpan = telemetry.finishedSpans
      .slice(start)
      .find((span) => span.events.some((event) => event.name === 'tool_idempotency_hit'));
    expect(toolSpan).toBeDefined();
  });

  it('handles concurrent calls with the same idempotency key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = new InMemoryIdempotencyStore();
    const registry = new ToolRegistry({
      idempotencyStore: store,
      idempotencyOptions: { inProgressWaitMs: 10, inProgressMaxAttempts: 5 },
    });

    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    registry.register(
      createTool({
        name: 'slow_tool',
        description: 'Slow',
        input: z.object({ id: z.string() }),
        idempotent: true,
        execute: async ({ id }) => {
          calls += 1;
          await gate;
          return id;
        },
      }),
    );

    const runPromise = runWith({ runId: 'run-concurrent', stepId: 'step-a' }, async () => {
      const first = registry.execute('slow_tool', { id: 'x' });
      await vi.advanceTimersByTimeAsync(0);
      const second = registry.execute('slow_tool', { id: 'x' });
      release();
      return Promise.all([first, second]);
    });

    const [first, second] = await runPromise;

    expect(first.success).toBe(true);
    expect(calls).toBe(1);
    expect(second.success ? second.output : second.errorDetails?.name).toBeTruthy();

    vi.useRealTimers();
  });
});

describe('computeIdempotencyKey', () => {
  it('delegates to custom key functions with RunContext', async () => {
    await runWith({ runId: 'run-ctx', stepId: 'step-ctx' }, async () => {
      const key = computeIdempotencyKey(
        'tool',
        { a: 1 },
        ({ runContext, toolName, args }) =>
          sha256(canonicalStringify([runContext?.runId, runContext?.stepId, toolName, args])),
      );
      expect(key).toHaveLength(64);
    });
  });
});

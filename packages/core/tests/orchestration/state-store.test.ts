import { vi } from 'vitest';

const pgMocks = vi.hoisted(() => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const mockClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: true }] };
      }
      if (sql.startsWith('SELECT state')) {
        return {
          rows: [
            {
              state: {
                workflowId: 'pg-1',
                completedSteps: { draft: 'hello' },
                skippedSteps: [],
                stepDurations: { draft: 12 },
                currentStepId: 'review',
                suspendedAt: Date.now(),
                workflowInput: 'task',
              },
            },
          ],
        };
      }
      if (sql.startsWith('SELECT workflow_id')) {
        return {
          rows: [
            {
              workflow_id: 'pg-1',
              current_step_id: 'review',
              reason: 'approval',
              tags: { orgId: 'org-a' },
              suspended_at: '1000',
              ttl_expiry: null,
            },
          ],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  return { queries, mockClient };
});

vi.mock('pg', () => ({
  Pool: class MockPool {
    query = pgMocks.mockClient.query;
    connect = vi.fn(async () => pgMocks.mockClient);
  },
}));

const redisMocks = vi.hoisted(() => {
  const commands: Array<{ method: string; args: unknown[] }> = [];
  const storage = new Map<string, string>();

  class MockRedis {
    get(key: string) {
      commands.push({ method: 'get', args: [key] });
      return Promise.resolve(storage.get(key) ?? null);
    }

    set(key: string, value: string, ...args: unknown[]) {
      commands.push({ method: 'set', args: [key, value, ...args] });
      if (args[2] === 'NX' && storage.has(key)) {
        return Promise.resolve(null);
      }
      storage.set(key, value);
      return Promise.resolve('OK' as const);
    }

    setex(key: string, seconds: number, value: string) {
      commands.push({ method: 'setex', args: [key, seconds, value] });
      storage.set(key, value);
      return Promise.resolve('OK' as const);
    }

    del(...keys: string[]) {
      commands.push({ method: 'del', args: keys });
      for (const key of keys) {
        storage.delete(key);
      }
      return Promise.resolve(keys.length);
    }

    scan(cursor: string, ...args: (string | number)[]) {
      commands.push({ method: 'scan', args: [cursor, ...args] });
      const keys = [...storage.keys()].filter((key) => key.includes(':meta:'));
      return Promise.resolve(['0', keys] as [string, string[]]);
    }

    eval(script: string, numKeys: number, ...args: string[]) {
      commands.push({ method: 'eval', args: [script, numKeys, ...args] });
      return Promise.resolve(1);
    }
  }

  return { commands, storage, MockRedis };
});

vi.mock('ioredis', () => ({
  default: redisMocks.MockRedis,
}));

import { describe, expect, it } from 'vitest';
import { DAGBuilder, WorkflowStateLockError } from '../../src/orchestration/dag.js';
import type { SuspendedWorkflowState } from '../../src/orchestration/dag-types.js';
import { InMemoryStateStore } from '../../src/orchestration/state-stores/in-memory.js';
import { PostgresStateStore } from '../../src/orchestration/state-stores/postgres.js';
import { RedisStateStore } from '../../src/orchestration/state-stores/redis.js';

function sampleState(workflowId: string): SuspendedWorkflowState {
  return {
    workflowId,
    completedSteps: { draft: 'hello' },
    skippedSteps: [],
    stepDurations: { draft: 12 },
    currentStepId: 'review',
    suspendedAt: Date.now(),
    workflowInput: 'task',
    pendingStepInput: { draft: 'hello' },
    suspensionMessage: 'Waiting for review',
  };
}

function buildReviewWorkflow(store?: InMemoryStateStore) {
  return new DAGBuilder()
    .addStep('draft', {
      name: 'Draft Email',
      execute: async (input: string) => `Draft for: ${input}`,
    })
    .addStep('review', {
      name: 'Human Review',
      suspend: true,
      execute: async (input) => input,
      dependencies: ['draft'],
    })
    .addStep('send', {
      name: 'Send Email',
      execute: async (input: { approved: boolean; edits?: string }) =>
        input.approved ? `Sent with edits: ${input.edits ?? 'none'}` : 'Not sent',
      dependencies: ['review'],
      inputMapper: (deps) => deps.review as { approved: boolean; edits?: string },
    })
    .build({ stateStore: store });
}

describe('InMemoryStateStore', () => {
  it('supports save, load, and delete roundtrip', async () => {
    const store = new InMemoryStateStore();
    const state = sampleState('roundtrip-1');

    await store.save('roundtrip-1', state);
    expect(await store.load('roundtrip-1')).toEqual(state);

    await store.delete('roundtrip-1');
    expect(await store.load('roundtrip-1')).toBeNull();
  });

  it('expires entries after ttlMs', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStateStore();
    const state = sampleState('ttl-1');

    await store.save('ttl-1', state, { ttlMs: 1_000 });
    expect(await store.load('ttl-1')).toEqual(state);

    vi.advanceTimersByTime(1_001);
    expect(await store.load('ttl-1')).toBeNull();
    expect(await store.list({ status: 'expired' })).toHaveLength(0);

    vi.useRealTimers();
  });

  it('lists active and expired runs with tag filters', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStateStore();

    await store.save('active-1', sampleState('active-1'), {
      tags: { orgId: 'org-a', agentName: 'reviewer' },
      reason: 'approval',
    });
    await store.save('expired-1', sampleState('expired-1'), {
      ttlMs: 500,
      tags: { orgId: 'org-b' },
    });

    vi.advanceTimersByTime(501);

    const active = await store.list({
      status: 'suspended',
      tags: { orgId: 'org-a' },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.workflowId).toBe('active-1');
    expect(active[0]?.reason).toBe('approval');

    const expired = await store.list({ status: 'expired' });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.workflowId).toBe('expired-1');

    vi.useRealTimers();
  });

  it('prevents concurrent resume with acquireLock', async () => {
    const store = new InMemoryStateStore();
    const first = await store.acquireLock('wf-lock', 5_000);
    const second = await store.acquireLock('wf-lock', 5_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await first!.release();
    const third = await store.acquireLock('wf-lock', 5_000);
    expect(third).not.toBeNull();
    await third!.release();
  });
});

describe('PostgresStateStore', () => {
  it('executes expected SQL for save, load, list, delete, and advisory lock', async () => {
    pgMocks.queries.length = 0;
    const store = new PostgresStateStore({ connectionString: 'postgres://localhost/test' });
    const state = sampleState('pg-1');

    await store.save('pg-1', state, { reason: 'approval', tags: { orgId: 'org-a' } });
    expect(pgMocks.queries.some((entry) => entry.sql.includes('INSERT INTO ottrix_workflow_state'))).toBe(
      true,
    );

    await store.load('pg-1');
    expect(pgMocks.queries.some((entry) => entry.sql.includes('SELECT state'))).toBe(true);

    await store.list({ tags: { orgId: 'org-a' }, status: 'suspended', limit: 10, offset: 0 });
    expect(pgMocks.queries.some((entry) => entry.sql.includes('tags ->>'))).toBe(true);
    expect(pgMocks.queries.some((entry) => entry.sql.includes('LIMIT'))).toBe(true);

    await store.delete('pg-1');
    expect(pgMocks.queries.some((entry) => entry.sql.includes('DELETE FROM ottrix_workflow_state'))).toBe(
      true,
    );

    const lock = await store.acquireLock('pg-1', 1_000);
    expect(pgMocks.queries.some((entry) => entry.sql.includes('pg_try_advisory_lock'))).toBe(true);
    await lock?.release();
    expect(pgMocks.queries.some((entry) => entry.sql.includes('pg_advisory_unlock'))).toBe(true);
  });
});

describe('RedisStateStore', () => {
  it('uses SETEX, SCAN, SET NX PX, and eval for lock lifecycle', async () => {
    redisMocks.commands.length = 0;
    redisMocks.storage.clear();

    const store = new RedisStateStore({ url: 'redis://localhost:6379' });
    const state = sampleState('redis-1');

    await store.save('redis-1', state, { ttlMs: 2_000, tags: { orgId: 'org-a' } });
    expect(redisMocks.commands.some((entry) => entry.method === 'setex')).toBe(true);

    await store.load('redis-1');
    expect(redisMocks.commands.some((entry) => entry.method === 'get')).toBe(true);

    await store.list({ tags: { orgId: 'org-a' } });
    expect(redisMocks.commands.some((entry) => entry.method === 'scan')).toBe(true);

    const lock = await store.acquireLock('redis-1', 1_000);
    expect(redisMocks.commands.some((entry) => entry.method === 'set' && entry.args.includes('NX'))).toBe(
      true,
    );
    await lock?.release();
    expect(redisMocks.commands.some((entry) => entry.method === 'eval')).toBe(true);

    await store.delete('redis-1');
    expect(redisMocks.commands.some((entry) => entry.method === 'del')).toBe(true);
  });
});

describe('DAGWorkflow with stateStore', () => {
  it('auto-persists on suspend and auto-loads on resume', async () => {
    const store = new InMemoryStateStore();
    const workflow = buildReviewWorkflow(store);

    const suspended = await workflow.run('Quarterly update', { workflowId: 'wf-store-1' });
    expect(suspended.status).toBe('suspended');

    const loaded = await store.load('wf-store-1');
    expect(loaded?.workflowId).toBe('wf-store-1');
    expect(loaded?.currentStepId).toBe('review');

    const completed = await workflow.resume({
      workflowId: 'wf-store-1',
      stepOutput: { approved: true, edits: 'Updated intro' },
    });

    expect(completed.status).toBe('completed');
    expect(completed.finalOutput).toBe('Sent with edits: Updated intro');
  });

  it('prevents double-resume with the store lock', async () => {
    const store = new InMemoryStateStore();
    const workflow = buildReviewWorkflow(store);

    await workflow.run('Lock test', { workflowId: 'wf-lock-resume' });
    const lock = await store.acquireLock('wf-lock-resume', 5_000);

    await expect(
      workflow.resume({
        workflowId: 'wf-lock-resume',
        stepOutput: { approved: true },
      }),
    ).rejects.toThrow(WorkflowStateLockError);

    await lock!.release();
  });

  it('cleans up persisted state after completion', async () => {
    const store = new InMemoryStateStore();
    const workflow = buildReviewWorkflow(store);

    await workflow.run('Cleanup test', { workflowId: 'wf-cleanup' });
    expect(await store.load('wf-cleanup')).not.toBeNull();

    await workflow.resume({
      workflowId: 'wf-cleanup',
      stepOutput: { approved: true },
    });

    expect(await store.load('wf-cleanup')).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it('suspendTo returns a wrapper bound to the given store', async () => {
    const store = new InMemoryStateStore();
    const base = buildReviewWorkflow();
    const workflow = base.suspendTo(store, { saveMeta: { reason: 'approval' } });

    await workflow.run('Wrapper test', { workflowId: 'wf-wrapper' });
    const listed = await store.list({ status: 'suspended' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.reason).toBe('approval');
  });
});

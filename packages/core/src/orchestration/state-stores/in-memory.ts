import type {
  ListFilter,
  LockHandle,
  SaveMeta,
  SuspendedRunInfo,
  WorkflowStateStore,
} from '../state-store.js';
import type { SuspendedWorkflowState } from '../dag-types.js';

interface StoredEntry {
  state: SuspendedWorkflowState;
  reason?: string;
  tags?: Record<string, string>;
  ttlExpiry?: number;
}

interface LockRecord {
  token: symbol;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** In-memory {@link WorkflowStateStore} backed by Maps (development/tests). */
export class InMemoryStateStore implements WorkflowStateStore {
  private readonly states = new Map<string, StoredEntry>();
  private readonly locks = new Map<string, LockRecord>();

  save(workflowId: string, state: SuspendedWorkflowState, meta?: SaveMeta): Promise<void> {
    const ttlExpiry =
      meta?.ttlMs !== undefined ? Date.now() + meta.ttlMs : undefined;
    this.states.set(workflowId, {
      state: cloneState(state),
      reason: meta?.reason,
      tags: meta?.tags ? { ...meta.tags } : undefined,
      ttlExpiry,
    });
    return Promise.resolve();
  }

  load(workflowId: string): Promise<SuspendedWorkflowState | null> {
    const entry = this.states.get(workflowId);
    if (!entry) {
      return Promise.resolve(null);
    }
    if (entry.ttlExpiry !== undefined && entry.ttlExpiry <= Date.now()) {
      this.states.delete(workflowId);
      return Promise.resolve(null);
    }
    return Promise.resolve(cloneState(entry.state));
  }

  list(filter: ListFilter = {}): Promise<SuspendedRunInfo[]> {
    const now = Date.now();
    const rows: SuspendedRunInfo[] = [];

    for (const [workflowId, entry] of this.states) {
      const expired = entry.ttlExpiry !== undefined && entry.ttlExpiry <= now;
      if (filter.status === 'suspended' && expired) {
        continue;
      }
      if (filter.status === 'expired' && !expired) {
        continue;
      }
      if (filter.tags && !matchesTags(entry.tags, filter.tags)) {
        continue;
      }

      rows.push({
        workflowId,
        suspendedAt: entry.state.suspendedAt,
        currentStepId: entry.state.currentStepId,
        reason: entry.reason,
        tags: entry.tags ? { ...entry.tags } : undefined,
        ttlExpiry: entry.ttlExpiry,
      });
    }

    sortSuspendedRuns(rows, filter.orderBy ?? 'suspendedAt');

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? rows.length;
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  delete(workflowId: string): Promise<void> {
    this.states.delete(workflowId);
    this.releaseLockRecord(workflowId);
    return Promise.resolve();
  }

  acquireLock(workflowId: string, ttlMs: number): Promise<LockHandle | null> {
    const now = Date.now();
    const existing = this.locks.get(workflowId);
    if (existing && existing.expiresAt > now) {
      return Promise.resolve(null);
    }

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const token = Symbol('lock');
    const record: LockRecord = {
      token,
      expiresAt: now + ttlMs,
    };

    record.timer = setTimeout(() => {
      const current = this.locks.get(workflowId);
      if (current?.token === token) {
        this.locks.delete(workflowId);
      }
    }, ttlMs);
    record.timer.unref?.();

    this.locks.set(workflowId, record);

    return Promise.resolve({
      release: (): Promise<void> => {
        const current = this.locks.get(workflowId);
        if (current?.token === token) {
          this.releaseLockRecord(workflowId);
        }
        return Promise.resolve();
      },
      extend: (extendTtlMs: number): Promise<void> => {
        const current = this.locks.get(workflowId);
        if (!current || current.token !== token) {
          throw new Error(`Lock for workflow "${workflowId}" is no longer held`);
        }
        if (current.timer) {
          clearTimeout(current.timer);
        }
        current.expiresAt = Date.now() + extendTtlMs;
        current.timer = setTimeout(() => {
          const active = this.locks.get(workflowId);
          if (active?.token === token) {
            this.locks.delete(workflowId);
          }
        }, extendTtlMs);
        current.timer.unref?.();
        return Promise.resolve();
      },
    });
  }

  private releaseLockRecord(workflowId: string): void {
    const record = this.locks.get(workflowId);
    if (record?.timer) {
      clearTimeout(record.timer);
    }
    this.locks.delete(workflowId);
  }
}

function cloneState(state: SuspendedWorkflowState): SuspendedWorkflowState {
  return structuredClone(state);
}

function matchesTags(
  entryTags: Record<string, string> | undefined,
  filterTags: Record<string, string>,
): boolean {
  if (!entryTags) {
    return false;
  }
  return Object.entries(filterTags).every(([key, value]) => entryTags[key] === value);
}

function sortSuspendedRuns(rows: SuspendedRunInfo[], orderBy: 'suspendedAt' | 'ttlExpiry'): void {
  rows.sort((a, b) => {
    const left = orderBy === 'ttlExpiry' ? (a.ttlExpiry ?? Number.MAX_SAFE_INTEGER) : a.suspendedAt;
    const right = orderBy === 'ttlExpiry' ? (b.ttlExpiry ?? Number.MAX_SAFE_INTEGER) : b.suspendedAt;
    return left - right;
  });
}

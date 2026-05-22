import type { SuspendedWorkflowState } from '../dag-types.js';
import type {
  ListFilter,
  LockHandle,
  SaveMeta,
  SuspendedRunInfo,
  WorkflowStateStore,
} from '../state-store.js';
import { importOptionalPeer, tagsMatch } from './shared.js';

export interface RedisStateStoreOptions {
  url: string;
  keyPrefix?: string;
}

interface RedisMetaRecord {
  reason?: string;
  tags?: Record<string, string>;
  suspendedAt: number;
  currentStepId: string;
  ttlExpiry?: number;
}

interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null>;
  setex(key: string, seconds: number, value: string): Promise<'OK'>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<number>;
}

/** Redis-backed {@link WorkflowStateStore} using `ioredis` (optional peer dependency). */
export class RedisStateStore implements WorkflowStateStore {
  private readonly keyPrefix: string;
  private readonly url: string;
  private client: RedisClient | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: RedisStateStoreOptions) {
    this.url = options.url;
    this.keyPrefix = options.keyPrefix ?? 'ottrix:workflow';
  }

  async save(workflowId: string, state: SuspendedWorkflowState, meta?: SaveMeta): Promise<void> {
    const redis = await this.getClient();
    const stateKey = this.stateKey(workflowId);
    const metaKey = this.metaKey(workflowId);
    const payload = JSON.stringify(state);
    const metaRecord: RedisMetaRecord = {
      reason: meta?.reason,
      tags: meta?.tags,
      suspendedAt: state.suspendedAt,
      currentStepId: state.currentStepId,
      ttlExpiry: meta?.ttlMs !== undefined ? Date.now() + meta.ttlMs : undefined,
    };

    if (meta?.ttlMs !== undefined) {
      const ttlSeconds = Math.max(1, Math.ceil(meta.ttlMs / 1000));
      await redis.setex(stateKey, ttlSeconds, payload);
      await redis.setex(metaKey, ttlSeconds, JSON.stringify(metaRecord));
      return;
    }

    await redis.set(stateKey, payload);
    await redis.set(metaKey, JSON.stringify(metaRecord));
  }

  async load(workflowId: string): Promise<SuspendedWorkflowState | null> {
    const redis = await this.getClient();
    const payload = await redis.get(this.stateKey(workflowId));
    if (!payload) {
      return null;
    }
    return JSON.parse(payload) as SuspendedWorkflowState;
  }

  async list(filter: ListFilter = {}): Promise<SuspendedRunInfo[]> {
    const redis = await this.getClient();
    const rows: SuspendedRunInfo[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${this.keyPrefix}:meta:*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;

      for (const metaKey of keys) {
        const workflowId = metaKey.slice(`${this.keyPrefix}:meta:`.length);
        const metaPayload = await redis.get(metaKey);
        if (!metaPayload) {
          continue;
        }

        const meta = JSON.parse(metaPayload) as RedisMetaRecord;
        const expired = meta.ttlExpiry !== undefined && meta.ttlExpiry <= Date.now();
        if (filter.status === 'suspended' && expired) {
          continue;
        }
        if (filter.status === 'expired' && !expired) {
          continue;
        }
        if (!tagsMatch(meta.tags, filter.tags)) {
          continue;
        }

        rows.push({
          workflowId,
          suspendedAt: meta.suspendedAt,
          currentStepId: meta.currentStepId,
          reason: meta.reason,
          tags: meta.tags,
          ttlExpiry: meta.ttlExpiry,
        });
      }
    } while (cursor !== '0');

    sortSuspendedRuns(rows, filter.orderBy ?? 'suspendedAt');

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async delete(workflowId: string): Promise<void> {
    const redis = await this.getClient();
    await redis.del(this.stateKey(workflowId), this.metaKey(workflowId), this.lockKey(workflowId));
  }

  async acquireLock(workflowId: string, ttlMs: number): Promise<LockHandle | null> {
    const redis = await this.getClient();
    const lockKey = this.lockKey(workflowId);
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');

    if (result !== 'OK') {
      return null;
    }

    let released = false;
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await redis.eval(releaseScript, 1, lockKey, token);
      },
      extend: async (extendTtlMs: number) => {
        if (released) {
          throw new Error(`Lock for workflow "${workflowId}" is no longer held`);
        }
        const extendScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        const extended = await redis.eval(extendScript, 1, lockKey, token, String(extendTtlMs));
        if (extended !== 1) {
          throw new Error(`Lock for workflow "${workflowId}" is no longer held`);
        }
      },
    };
  }

  private async getClient(): Promise<RedisClient> {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
    return this.client!;
  }

  private async initialize(): Promise<void> {
    const ioredis = await importOptionalPeer<{ default?: new (url: string) => RedisClient }>('ioredis');
    const RedisCtor = ioredis.default ?? (ioredis as unknown as new (url: string) => RedisClient);
    this.client = new RedisCtor(this.url);
  }

  private stateKey(workflowId: string): string {
    return `${this.keyPrefix}:state:${workflowId}`;
  }

  private metaKey(workflowId: string): string {
    return `${this.keyPrefix}:meta:${workflowId}`;
  }

  private lockKey(workflowId: string): string {
    return `${this.keyPrefix}:lock:${workflowId}`;
  }
}

function sortSuspendedRuns(rows: SuspendedRunInfo[], orderBy: 'suspendedAt' | 'ttlExpiry'): void {
  rows.sort((a, b) => {
    const left = orderBy === 'ttlExpiry' ? (a.ttlExpiry ?? Number.MAX_SAFE_INTEGER) : a.suspendedAt;
    const right = orderBy === 'ttlExpiry' ? (b.ttlExpiry ?? Number.MAX_SAFE_INTEGER) : b.suspendedAt;
    return left - right;
  });
}

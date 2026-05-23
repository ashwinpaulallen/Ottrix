import type { SuspendedWorkflowState } from '../dag-types.js';
import type {
  ListFilter,
  LockHandle,
  SaveMeta,
  SuspendedRunInfo,
  WorkflowStateStore,
} from '../state-store.js';
import { advisoryLockKeys, importOptionalPeer } from './shared.js';

export interface PostgresStateStoreOptions {
  connectionString: string;
  tableName?: string;
}

const DEFAULT_TABLE = 'ottrix_workflow_state';

interface PgQueryResult<T = unknown> {
  rows: T[];
}

interface PgPoolClient {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<PgQueryResult<T>>;
  release: () => void;
}

interface PgPool {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<PgQueryResult<T>>;
  connect: () => Promise<PgPoolClient>;
}

/** PostgreSQL-backed {@link WorkflowStateStore} using raw `pg` (optional peer dependency). */
export class PostgresStateStore implements WorkflowStateStore {
  private readonly tableName: string;
  private readonly connectionString: string;
  private pool: PgPool | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: PostgresStateStoreOptions) {
    this.connectionString = options.connectionString;
    this.tableName = options.tableName ?? DEFAULT_TABLE;
  }

  async save(workflowId: string, state: SuspendedWorkflowState, meta?: SaveMeta): Promise<void> {
    await this.ensureReady();
    const ttlExpiry =
      meta?.ttlMs !== undefined ? new Date(Date.now() + meta.ttlMs).toISOString() : null;

    await this.pool!.query(
      `INSERT INTO ${this.tableName} (
         workflow_id, state, current_step_id, reason, tags, suspended_at, ttl_expiry
       ) VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0), $7::timestamptz)
       ON CONFLICT (workflow_id) DO UPDATE SET
         state = EXCLUDED.state,
         current_step_id = EXCLUDED.current_step_id,
         reason = EXCLUDED.reason,
         tags = EXCLUDED.tags,
         suspended_at = EXCLUDED.suspended_at,
         ttl_expiry = EXCLUDED.ttl_expiry`,
      [
        workflowId,
        JSON.stringify(state),
        state.currentStepId,
        meta?.reason ?? null,
        JSON.stringify(meta?.tags ?? {}),
        state.suspendedAt,
        ttlExpiry,
      ],
    );
  }

  async load(workflowId: string): Promise<SuspendedWorkflowState | null> {
    await this.ensureReady();
    const result = await this.pool!.query<{ state: SuspendedWorkflowState }>(
      `SELECT state
       FROM ${this.tableName}
       WHERE workflow_id = $1
         AND (ttl_expiry IS NULL OR ttl_expiry > NOW())`,
      [workflowId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].state;
  }

  async list(filter: ListFilter = {}): Promise<SuspendedRunInfo[]> {
    await this.ensureReady();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status === 'suspended') {
      conditions.push('(ttl_expiry IS NULL OR ttl_expiry > NOW())');
    } else if (filter.status === 'expired') {
      conditions.push('(ttl_expiry IS NOT NULL AND ttl_expiry <= NOW())');
    }

    if (filter.tags) {
      for (const [key, value] of Object.entries(filter.tags)) {
        params.push(key, value);
        conditions.push(`tags ->> $${params.length - 1} = $${params.length}`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy =
      filter.orderBy === 'ttlExpiry'
        ? 'ttl_expiry ASC NULLS LAST'
        : 'suspended_at ASC';

    let query = `SELECT workflow_id, current_step_id, reason, tags,
                        EXTRACT(EPOCH FROM suspended_at) * 1000 AS suspended_at,
                        EXTRACT(EPOCH FROM ttl_expiry) * 1000 AS ttl_expiry
                 FROM ${this.tableName}
                 ${whereClause}
                 ORDER BY ${orderBy}`;

    if (filter.limit !== undefined) {
      params.push(filter.limit);
      query += ` LIMIT $${params.length}`;
    }
    if (filter.offset !== undefined) {
      params.push(filter.offset);
      query += ` OFFSET $${params.length}`;
    }

    const result = await this.pool!.query<{
      workflow_id: string;
      current_step_id: string;
      reason: string | null;
      tags: Record<string, string> | null;
      suspended_at: string;
      ttl_expiry: string | null;
    }>(query, params);

    return result.rows.map((row) => ({
      workflowId: row.workflow_id,
      suspendedAt: Number(row.suspended_at),
      currentStepId: row.current_step_id,
      reason: row.reason ?? undefined,
      tags: row.tags ?? undefined,
      ttlExpiry: row.ttl_expiry !== null ? Number(row.ttl_expiry) : undefined,
    }));
  }

  async delete(workflowId: string): Promise<void> {
    await this.ensureReady();
    await this.pool!.query(`DELETE FROM ${this.tableName} WHERE workflow_id = $1`, [workflowId]);
  }

  async acquireLock(workflowId: string, ttlMs: number): Promise<LockHandle | null> {
    await this.ensureReady();
    const client = await this.pool!.connect();
    const [key1, key2] = advisoryLockKeys(workflowId);

    try {
      const lockResult = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [key1, key2],
      );

      if (!lockResult.rows[0]?.locked) {
        client.release();
        return null;
      }

      let released = false;
      const releaseLock = async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [key1, key2]);
        } finally {
          client.release();
        }
      };

      let extendTimer: ReturnType<typeof setTimeout> | undefined;
      let currentTtlMs = ttlMs;
      const scheduleRelease = (): void => {
        if (extendTimer) {
          clearTimeout(extendTimer);
        }
        extendTimer = setTimeout(() => {
          void releaseLock();
        }, currentTtlMs);
        extendTimer.unref?.();
      };

      scheduleRelease();

      return {
        release: releaseLock,
        extend: (extendTtlMs: number): Promise<void> => {
          if (released) {
            throw new Error(`Lock for workflow "${workflowId}" is no longer held`);
          }
          currentTtlMs = extendTtlMs;
          scheduleRelease();
          return Promise.resolve();
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const pg = await importOptionalPeer<{ Pool: new (config: { connectionString: string }) => PgPool }>('pg');
    this.pool = new pg.Pool({ connectionString: this.connectionString });
    await this.ensureTable();
  }

  private async ensureTable(): Promise<void> {
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        workflow_id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        current_step_id TEXT,
        reason TEXT,
        tags JSONB DEFAULT '{}',
        suspended_at TIMESTAMPTZ DEFAULT NOW(),
        ttl_expiry TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }
}

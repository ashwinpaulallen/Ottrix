/** Current usage counters for a budget scope. */
export interface CurrentUsage {
  tokens: number;
  costUsd: number;
  steps: number;
}

/** Persistence layer for org/global (and shared run) budget scopes. */
export interface BudgetUsageStore {
  increment(
    scopeKey: string,
    usage: { tokens?: number; costUsd?: number; steps?: number },
    period?: string,
  ): Promise<CurrentUsage>;
  getUsage(scopeKey: string, period?: string): Promise<CurrentUsage>;
  reset(scopeKey: string): Promise<void>;
}

interface StoredEntry extends CurrentUsage {
  period?: string;
  periodStartMs?: number;
}

/** In-memory {@link BudgetUsageStore} for development and tests. */
export class InMemoryBudgetStore implements BudgetUsageStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now;
  }

  increment(
    scopeKey: string,
    usage: { tokens?: number; costUsd?: number; steps?: number },
    period?: string,
  ): Promise<CurrentUsage> {
    const key = buildStoreKey(scopeKey, period);
    const current = this.entries.get(key) ?? { tokens: 0, costUsd: 0, steps: 0 };
    const next: StoredEntry = {
      tokens: current.tokens + (usage.tokens ?? 0),
      costUsd: current.costUsd + (usage.costUsd ?? 0),
      steps: current.steps + (usage.steps ?? 0),
      period,
      periodStartMs: current.periodStartMs ?? this.now(),
    };
    this.entries.set(key, next);
    return Promise.resolve({ tokens: next.tokens, costUsd: next.costUsd, steps: next.steps });
  }

  getUsage(scopeKey: string, period?: string): Promise<CurrentUsage> {
    const key = buildStoreKey(scopeKey, period);
    const current = this.entries.get(key);
    return Promise.resolve(
      current ? { tokens: current.tokens, costUsd: current.costUsd, steps: current.steps } : {
          tokens: 0,
          costUsd: 0,
          steps: 0,
        },
    );
  }

  reset(scopeKey: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key === scopeKey || key.startsWith(`${scopeKey}:`)) {
        this.entries.delete(key);
      }
    }
    return Promise.resolve();
  }

  /** @internal Synchronous read for tests and legacy callers using {@link InMemoryBudgetStore}. */
  getUsageSync(scopeKey: string, period?: string): CurrentUsage {
    const key = period ? `${scopeKey}:${period}` : scopeKey;
    const current = this.entries.get(key);
    return current
      ? { tokens: current.tokens, costUsd: current.costUsd, steps: current.steps }
      : { tokens: 0, costUsd: 0, steps: 0 };
  }

  /** @internal */
  get entriesMap(): Map<string, StoredEntry> {
    return this.entries;
  }
}

function buildStoreKey(scopeKey: string, period?: string): string {
  return period ? `${scopeKey}:${period}` : scopeKey;
}

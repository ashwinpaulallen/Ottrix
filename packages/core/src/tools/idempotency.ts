import { getRunContext, type RunContext } from '../context/run-context.js';
import { Logger } from '../observability/logger.js';
import { canonicalStringify, sha256 } from '../utils/hash.js';
import type { ToolResult } from '../types/tools.js';

/** Result of {@link IdempotencyStore.begin}. */
export type IdempotencyCheckResult =
  | { status: 'fresh' }
  | { status: 'done'; result: unknown }
  | { status: 'in_progress'; startedAt: number };

/** Ledger for effectively-once tool execution. */
export interface IdempotencyStore {
  begin(key: string): Promise<IdempotencyCheckResult>;
  complete(key: string, result: unknown): Promise<void>;
  fail(key: string, error: unknown): Promise<void>;
}

export interface InMemoryIdempotencyStoreOptions {
  /** Entry TTL in milliseconds. @defaultValue 86400000 (24h) */
  ttlMs?: number;
}

interface LedgerEntry {
  status: 'in_progress' | 'done';
  result?: unknown;
  startedAt: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Map-backed {@link IdempotencyStore} for development and tests. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 86_400_000;
  }

  begin(key: string): Promise<IdempotencyCheckResult> {
    const existing = this.entries.get(key);
    const now = Date.now();

    if (existing && existing.expiresAt > now) {
      if (existing.status === 'done') {
        return Promise.resolve({ status: 'done', result: existing.result });
      }
      return Promise.resolve({ status: 'in_progress', startedAt: existing.startedAt });
    }

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const entry: LedgerEntry = {
      status: 'in_progress',
      startedAt: now,
      expiresAt: now + this.ttlMs,
    };
    entry.timer = this.scheduleExpiry(key, entry);
    this.entries.set(key, entry);

    return Promise.resolve({ status: 'fresh' });
  }

  complete(key: string, result: unknown): Promise<void> {
    const existing = this.entries.get(key);
    const now = Date.now();
    const entry: LedgerEntry = {
      status: 'done',
      result: structuredClone(result),
      startedAt: existing?.startedAt ?? now,
      expiresAt: now + this.ttlMs,
    };

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    entry.timer = this.scheduleExpiry(key, entry);
    this.entries.set(key, entry);
    return Promise.resolve();
  }

  fail(key: string, _error: unknown): Promise<void> {
    this.deleteEntry(key);
    return Promise.resolve();
  }

  /** @internal Test helper — number of tracked keys. */
  size(): number {
    return this.entries.size;
  }

  private scheduleExpiry(key: string, entry: LedgerEntry): ReturnType<typeof setTimeout> {
    const delay = Math.max(0, entry.expiresAt - Date.now());
    const timer = setTimeout(() => {
      const current = this.entries.get(key);
      if (current === entry) {
        this.entries.delete(key);
      }
    }, delay);
    timer.unref?.();
    return timer;
  }

  private deleteEntry(key: string): void {
    const existing = this.entries.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.entries.delete(key);
  }
}

/** Context passed to custom {@link IdempotencyKeyFn} implementations. */
export interface IdempotencyKeyContext {
  args: Record<string, unknown>;
  toolName: string;
  runContext?: RunContext;
}

/** Custom idempotency key generator for a tool. */
export type IdempotencyKeyFn = (ctx: IdempotencyKeyContext) => string;

export interface IdempotencyExecutionOptions {
  inProgressWaitMs?: number;
  inProgressMaxAttempts?: number;
}

export const DEFAULT_IDEMPOTENCY_WAIT_MS = 50;
export const DEFAULT_IDEMPOTENCY_MAX_ATTEMPTS = 20;

export const TOOL_IDEMPOTENCY_IN_PROGRESS_NAME = 'ToolIdempotencyInProgress';

let globalIdempotencyStore: IdempotencyStore | undefined;
let globalIdempotencyOptions: IdempotencyExecutionOptions = {};

/** Configure the global idempotency store for all idempotent tools. */
export function useIdempotencyStore(
  store: IdempotencyStore,
  options?: IdempotencyExecutionOptions,
): void {
  globalIdempotencyStore = store;
  if (options) {
    globalIdempotencyOptions = { ...options };
  }
}

/** Returns the globally configured idempotency store, if any. */
export function getIdempotencyStore(): IdempotencyStore | undefined {
  return globalIdempotencyStore;
}

/** Returns global idempotency execution options. */
export function getIdempotencyOptions(): IdempotencyExecutionOptions {
  return globalIdempotencyOptions;
}

/** Reset global idempotency configuration (for tests). */
export function resetIdempotencyStore(): void {
  globalIdempotencyStore = undefined;
  globalIdempotencyOptions = {};
}

/** Whether a tool is marked idempotent via metadata. */
export function isIdempotentTool(tool: { metadata?: { idempotent?: boolean } }): boolean {
  return tool.metadata?.idempotent === true;
}

/** Resolve the idempotency store for a tool execution. */
export function resolveIdempotencyStore(
  toolStore: IdempotencyStore | undefined,
  registryStore: IdempotencyStore | undefined,
): IdempotencyStore | undefined {
  return toolStore ?? registryStore ?? globalIdempotencyStore;
}

/** Generate the default idempotency key for a tool invocation. */
export function generateDefaultIdempotencyKey(
  toolName: string,
  args: Record<string, unknown>,
  logger: Logger = new Logger({ component: 'Idempotency' }),
): string {
  const runContext = getRunContext();
  const canonicalArgs = canonicalStringify(args);

  if (!runContext?.runId) {
    logger.warn(
      'Idempotency without RunContext may produce incorrect keys across runs',
      { toolName },
    );
    return sha256(canonicalStringify([toolName, canonicalArgs]));
  }

  return sha256(
    canonicalStringify([
      runContext.runId,
      runContext.stepId ?? null,
      toolName,
      canonicalArgs,
    ]),
  );
}

/** Compute an idempotency key for a tool invocation. */
export function computeIdempotencyKey(
  toolName: string,
  args: Record<string, unknown>,
  keyFn: IdempotencyKeyFn | undefined,
  logger?: Logger,
): string {
  const runContext = getRunContext();
  if (keyFn) {
    return keyFn({ args, toolName, runContext });
  }
  return generateDefaultIdempotencyKey(toolName, args, logger);
}

/** Build a structured result when an idempotency slot is still in progress. */
export function buildIdempotencyInProgressResult(toolName: string, key: string): ToolResult {
  return {
    success: false,
    output: null,
    error: `Tool "${toolName}" is already executing for this idempotency key`,
    errorDetails: {
      name: TOOL_IDEMPOTENCY_IN_PROGRESS_NAME,
      data: { key },
    },
  };
}

export async function waitForIdempotencyResult(
  store: IdempotencyStore,
  key: string,
  options: IdempotencyExecutionOptions = {},
): Promise<IdempotencyCheckResult> {
  const waitMs = options.inProgressWaitMs ?? DEFAULT_IDEMPOTENCY_WAIT_MS;
  const maxAttempts = options.inProgressMaxAttempts ?? DEFAULT_IDEMPOTENCY_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const check = await store.begin(key);
    if (check.status !== 'in_progress') {
      return check;
    }
    await sleep(waitMs);
  }

  const finalCheck = await store.begin(key);
  if (finalCheck.status === 'in_progress') {
    return finalCheck;
  }
  return finalCheck;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

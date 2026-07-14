import { CAPABILITY } from './types.js';
import type { TokenBreakdown, CapabilityUsage, TokenRecord } from './types.js';

/**
 * Tracks token usage across nested capability scopes for a single agent run.
 *
 * Scope stack is per-instance — use one accumulator per concurrent run (or
 * per parallel branch) so nested {@link withScope} calls do not interfere.
 */
export class TokenAccumulator {
  private byCapability: Map<string, CapabilityUsage> = new Map();
  private scopeStack: string[] = [];
  private currentScope: string = CAPABILITY.UNSCOPED;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalCalls = 0;

  constructor(private readonly runId: string) {}

  // ── Scope management ─────────────────────────────────────────────────────

  /** Push the current scope and switch to `capability`. */
  enterScope(capability: string): void {
    this.scopeStack.push(this.currentScope);
    this.currentScope = capability;
    this.ensureCapability(capability);
  }

  /** Pop the previous scope (or {@link CAPABILITY.UNSCOPED} if the stack is empty). */
  exitScope(): void {
    this.currentScope = this.scopeStack.pop() ?? CAPABILITY.UNSCOPED;
  }

  /** Run `fn` inside a capability scope; always exits, even if `fn` throws. */
  async withScope<T>(capability: string, fn: () => Promise<T>): Promise<T> {
    this.enterScope(capability);
    try {
      return await fn();
    } finally {
      this.exitScope();
    }
  }

  // ── Recording ────────────────────────────────────────────────────────────

  /** Attribute a token record to the current scope and global totals. */
  record(tokens: TokenRecord): void {
    const {
      inputTokens,
      outputTokens,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
    } = tokens;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheReadTokens += cacheReadTokens;
    this.totalCacheWriteTokens += cacheWriteTokens;
    this.totalCalls += 1;

    const scope = this.ensureCapability(this.currentScope);
    scope.inputTokens += inputTokens;
    scope.outputTokens += outputTokens;
    scope.cacheReadTokens += cacheReadTokens;
    scope.cacheWriteTokens += cacheWriteTokens;
    scope.calls += 1;
  }

  // ── Output ───────────────────────────────────────────────────────────────

  /** Snapshot totals and per-capability usage for this run. */
  getBreakdown(): TokenBreakdown {
    const byCapability = Object.fromEntries(this.byCapability.entries());
    const totalTokens = this.totalInputTokens + this.totalOutputTokens;

    let topByTokens: string | undefined;
    let maxTokens = 0;
    for (const [name, usage] of this.byCapability) {
      const total = usage.inputTokens + usage.outputTokens;
      if (total > maxTokens) {
        maxTokens = total;
        topByTokens = name;
      }
    }

    return {
      runId: this.runId,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      totalTokens,
      totalCalls: this.totalCalls,
      byCapability,
      topCapabilityByTokens: topByTokens,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private ensureCapability(name: string): CapabilityUsage {
    let entry = this.byCapability.get(name);
    if (!entry) {
      entry = {
        capability: name,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 0,
      };
      this.byCapability.set(name, entry);
    }
    return entry;
  }

  /** Active capability scope name. */
  getCurrentScope(): string {
    return this.currentScope;
  }

  /** Whether any usage has been recorded (or scope entered) for `capability`. */
  hasScope(capability: string): boolean {
    return this.byCapability.has(capability);
  }
}

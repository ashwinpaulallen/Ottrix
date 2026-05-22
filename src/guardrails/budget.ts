import { getRunContext, type RunContext } from '../context/run-context.js';
import { emitAuditEvent } from './audit.js';
import type { TokenUsage } from '../types/provider.js';
import type {
  GuardrailBlockCode,
  GuardrailDecision,
  GuardrailHandler,
  LlmGuardrailContext,
  StatefulGuardrailHandler,
  ToolGuardrailContext,
} from './types.js';
import {
  InMemoryBudgetStore,
  type BudgetUsageStore,
  type CurrentUsage,
} from './budget-store.js';

/** Per-1k-token pricing used for cost estimation. */
export interface TokenCostRates {
  inputPer1k: number;
  outputPer1k: number;
}

/** Rolling window for org/global caps. */
export type BudgetPeriod = 'run' | 'hour' | 'day' | 'month';

/** Caps for a single budget scope. */
export interface BudgetCap {
  maxTokens?: number;
  maxCostUsd?: number;
  maxSteps?: number;
  period?: BudgetPeriod;
}

/** Action when a scope breaches its cap. */
export type BudgetBreachAction = 'terminate' | 'requestApproval' | 'flag' | 'warn';

/** A named budget scope in the enforcement stack. */
export interface BudgetScope {
  name: string;
  source: string | ((ctx: RunContext) => string);
  cap: BudgetCap;
  onBreach?: BudgetBreachAction;
}

/** Full budget configuration with ordered scope stack. */
export interface BudgetConfig {
  scopes: BudgetScope[];
  onBreachDefault: BudgetBreachAction;
  store?: BudgetUsageStore;
  defaultCostPer1k?: TokenCostRates;
  costPer1kByProvider?: Record<string, TokenCostRates>;
  providerName?: string;
  now?: () => number;
}

/** Legacy flat options — converted to a single agent scope. */
export interface BudgetGuardrailOptions {
  maxSteps?: number;
  maxTokenBudget?: number;
  maxCostUsd?: number;
  defaultCostPer1k?: TokenCostRates;
  costPer1kByProvider?: Record<string, TokenCostRates>;
  providerName?: string;
}

/** Used/limit/remaining for a single budget dimension. */
export interface BudgetSlice {
  used: number;
  limit?: number;
  remaining?: number;
}

/** Snapshot of remaining budget headroom. */
export interface RemainingBudget {
  steps: BudgetSlice;
  tokens: BudgetSlice;
  costUsd: BudgetSlice;
}

/** Usage vs cap for one scope. */
export interface ScopeBudgetStatus {
  name: string;
  scopeKey?: string;
  usage: CurrentUsage;
  cap: BudgetCap;
  remaining: RemainingBudget;
}

const SCOPE_ORDER = ['agent', 'run', 'org', 'global'] as const;

let configuredBudgets: BudgetConfig | undefined;
let defaultBudgetStore: BudgetUsageStore = new InMemoryBudgetStore();

/** Configure global budget scopes (agent → run → org → global). */
export function configureBudgets(config: BudgetConfig): void {
  configuredBudgets = config;
  if (config.store) {
    defaultBudgetStore = config.store;
  }
}

/** Returns the global budget configuration, if set. */
export function getConfiguredBudgets(): BudgetConfig | undefined {
  return configuredBudgets;
}

/** Replace the default shared budget store (for tests). */
export function setDefaultBudgetStore(store: BudgetUsageStore): void {
  defaultBudgetStore = store;
}

/**
 * Tracks step, token, and cost budgets across a stack of scopes.
 * Innermost scope (agent) is checked first; first breach wins.
 */
export class BudgetGuardrail implements GuardrailHandler, StatefulGuardrailHandler {
  readonly name = 'budget';

  private readonly config: BudgetConfig;
  private readonly store: BudgetUsageStore;
  private readonly defaultCostPer1k: TokenCostRates;
  private readonly costPer1kByProvider: Record<string, TokenCostRates>;
  private readonly providerName?: string;
  private readonly now: () => number;
  private readonly sortedScopes: BudgetScope[];
  private lastAgentName?: string;

  constructor(options: BudgetConfig | BudgetGuardrailOptions = {}) {
    this.config = isBudgetConfig(options) ? options : legacyOptionsToConfig(options);
    this.store = this.config.store ?? defaultBudgetStore;
    this.defaultCostPer1k = this.config.defaultCostPer1k ?? { inputPer1k: 0.005, outputPer1k: 0.015 };
    this.costPer1kByProvider = this.config.costPer1kByProvider ?? {};
    this.providerName = this.config.providerName;
    this.now = this.config.now ?? Date.now;
    this.sortedScopes = sortScopes(this.config.scopes);
  }

  reset(): void {
    // Shared store retains org/global usage; run/agent scopes reset per key on demand.
  }

  getRemainingBudget(scopeName?: string): RemainingBudget {
    const statuses = this.readScopeStatuses();
    if (scopeName) {
      const match = statuses.find((status) => status.name === scopeName);
      return match?.remaining ?? emptyRemaining();
    }
    return statuses[0]?.remaining ?? emptyRemaining();
  }

  /** Remaining budget for a scope when the key is known (HTTP guards, admin APIs). */
  async getScopeRemaining(scopeName: string, scopeKey: string): Promise<RemainingBudget> {
    const scope = this.sortedScopes.find((entry) => entry.name === scopeName);
    if (!scope) {
      return emptyRemaining();
    }
    const period = periodBucket(scope.cap.period, this.now());
    const storeKey = buildScopeStoreKey(scope.name, scopeKey);
    const usage = await this.store.getUsage(storeKey, period);
    return toRemaining(usage, scope.cap);
  }

  getAllBudgets(): Promise<ScopeBudgetStatus[]> {
    return Promise.all(
      this.sortedScopes.map(async (scope) => {
        const ctx = getRunContext();
        const scopeKey = resolveScopeKey(scope, ctx);
        const period = periodBucket(scope.cap.period, this.now());
        const storeKey = scopeKey ? buildScopeStoreKey(scope.name, scopeKey) : undefined;
        const usage = storeKey
          ? await this.store.getUsage(storeKey, period)
          : { tokens: 0, costUsd: 0, steps: 0 };

        return {
          name: scope.name,
          scopeKey,
          usage,
          cap: scope.cap,
          remaining: toRemaining(usage, scope.cap),
        };
      }),
    );
  }

  /** @deprecated Prefer {@link getAllBudgets}. Synchronous snapshot for innermost resolved scope. */
  getUsageSnapshot(): { steps: number; tokens: number; costUsd: number } {
    const statuses = this.readScopeStatuses();
    const innermost = statuses[0];
    return innermost?.usage ?? { steps: 0, tokens: 0, costUsd: 0 };
  }

  recordUsage(usage: TokenUsage, providerName?: string): void {
    this.syncApplyUsage({
      tokens: usage.totalTokens,
      costUsd: estimateCostUsd(usage, this.resolveRates(providerName)),
    });
  }

  beforeLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (context.timing !== 'pre') {
      return Promise.resolve();
    }

    return this.applyUsage({ steps: 1 }, `LLM call (${context.agentName})`, context.agentName);
  }

  afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (!context.result?.usage) {
      return Promise.resolve();
    }

    const costUsd = estimateCostUsd(context.result.usage, this.resolveRates(this.providerName));
    return this.applyUsage(
      { tokens: context.result.usage.totalTokens, costUsd },
      'LLM call',
      context.agentName,
    );
  }

  beforeTool(context: ToolGuardrailContext): Promise<GuardrailDecision | void> {
    if (context.timing !== 'pre') {
      return Promise.resolve();
    }

    return this.checkOnly(`tool "${context.toolName}"`, context.agentName);
  }

  afterTool(): Promise<GuardrailDecision | void> {
    return Promise.resolve();
  }

  private syncApplyUsage(
    delta: { tokens?: number; costUsd?: number; steps?: number },
    agentName?: string,
  ): void {
    const ctx = this.buildContext(agentName);
    for (const scope of this.applicableScopes(ctx)) {
      const scopeKey = resolveScopeKey(scope, ctx);
      if (!scopeKey) {
        continue;
      }
      const period = periodBucket(scope.cap.period, this.now());
      const storeKey = buildScopeStoreKey(scope.name, scopeKey);
      if (this.store instanceof InMemoryBudgetStore) {
        void this.store.increment(storeKey, delta, period);
      }
    }
  }

  private async applyUsage(
    delta: { tokens?: number; costUsd?: number; steps?: number },
    contextLabel: string,
    agentName?: string,
  ): Promise<GuardrailDecision | void> {
    const ctx = this.buildContext(agentName);
    const applicable = this.applicableScopes(ctx);

    for (const scope of applicable) {
      const scopeKey = resolveScopeKey(scope, ctx)!;
      const period = periodBucket(scope.cap.period, this.now());
      const storeKey = buildScopeStoreKey(scope.name, scopeKey);
      await this.store.increment(storeKey, delta, period);
    }

    return this.checkBreaches(applicable, ctx, contextLabel);
  }

  private async checkOnly(contextLabel: string, agentName?: string): Promise<GuardrailDecision | void> {
    const ctx = this.buildContext(agentName);
    return this.checkBreaches(this.applicableScopes(ctx), ctx, contextLabel);
  }

  private async checkBreaches(
    scopes: BudgetScope[],
    ctx: RunContext | undefined,
    contextLabel: string,
  ): Promise<GuardrailDecision | void> {
    for (const scope of scopes) {
      const scopeKey = resolveScopeKey(scope, ctx);
      if (!scopeKey) {
        continue;
      }

      const period = periodBucket(scope.cap.period, this.now());
      const storeKey = buildScopeStoreKey(scope.name, scopeKey);
      const usage = await this.store.getUsage(storeKey, period);
      const breach = detectBreach(scope.cap, usage);
      if (!breach) {
        continue;
      }

      return this.breachDecision(scope, breach, contextLabel, usage);
    }

    return;
  }

  private breachDecision(
    scope: BudgetScope,
    breach: GuardrailBlockCode,
    contextLabel: string,
    usage: CurrentUsage,
  ): GuardrailDecision {
    const action = scope.onBreach ?? this.config.onBreachDefault;
    const cap = scope.cap;
    const reason = breachReason(scope.name, breach, usage, cap, contextLabel);

    if (action === 'warn') {
      emitAuditEvent({
        type: 'budget.warn',
        actor: { type: 'system', id: 'budget', name: 'budget' },
        action: 'warn',
        resource: `budget:${scope.name}`,
        outcome: 'skipped',
        payload: { breach, reason, usage, cap },
      });
    } else {
      emitAuditEvent({
        type: 'budget.breach',
        actor: { type: 'system', id: 'budget', name: 'budget' },
        action,
        resource: `budget:${scope.name}`,
        outcome: action === 'flag' ? 'skipped' : 'denied',
        payload: { breach, reason, usage, cap },
      });
    }

    switch (action) {
      case 'requestApproval':
        return { action: 'suspend', code: breach, reason, flags: [`budget:${scope.name}:approval_required`] };
      case 'flag':
        return { action: 'flag', code: breach, reason, flags: [`budget:${scope.name}:${breach}`] };
      case 'warn':
        console.warn(`[budget:${scope.name}] ${reason}`);
        return { action: 'flag', code: breach, reason, flags: [`budget:${scope.name}:warn`] };
      case 'terminate':
      default:
        return { action: 'block', code: breach, reason };
    }
  }

  private applicableScopes(ctx: RunContext | undefined): BudgetScope[] {
    if (!ctx) {
      return this.sortedScopes.filter((scope) => scope.name === 'agent');
    }

    return this.sortedScopes.filter((scope) => resolveScopeKey(scope, ctx) !== undefined);
  }

  private buildContext(agentName?: string): RunContext | undefined {
    if (agentName) {
      this.lastAgentName = agentName;
    }
    const ctx = getRunContext();
    if (ctx) {
      return ctx;
    }
    if (agentName ?? this.lastAgentName) {
      return { runId: 'local', agentName: agentName ?? this.lastAgentName! };
    }
    return undefined;
  }

  private readScopeStatuses(): ScopeBudgetStatus[] {
    const ctx = this.buildContext(this.lastAgentName);
    return this.applicableScopes(ctx).map((scope) => {
      const scopeKey = resolveScopeKey(scope, ctx);
      const period = periodBucket(scope.cap.period, this.now());
      const storeKey = scopeKey ? buildScopeStoreKey(scope.name, scopeKey) : undefined;
      const usage =
        storeKey && this.store instanceof InMemoryBudgetStore
          ? this.store.getUsageSync(storeKey, period)
          : { tokens: 0, costUsd: 0, steps: 0 };

      return {
        name: scope.name,
        scopeKey,
        usage,
        cap: scope.cap,
        remaining: toRemaining(usage, scope.cap),
      };
    });
  }

  private resolveRates(providerName?: string): TokenCostRates {
    const named = providerName ? this.costPer1kByProvider[providerName] : undefined;
    return named ?? this.defaultCostPer1k;
  }
}

function isBudgetConfig(options: BudgetConfig | BudgetGuardrailOptions): options is BudgetConfig {
  return 'scopes' in options;
}

function legacyOptionsToConfig(options: BudgetGuardrailOptions): BudgetConfig {
  return {
    scopes: [
      {
        name: 'agent',
        source: (ctx) => ctx.agentName ?? 'agent',
        cap: {
          maxSteps: options.maxSteps,
          maxTokens: options.maxTokenBudget,
          maxCostUsd: options.maxCostUsd,
          period: 'run',
        },
      },
    ],
    onBreachDefault: 'terminate',
    defaultCostPer1k: options.defaultCostPer1k,
    costPer1kByProvider: options.costPer1kByProvider,
    providerName: options.providerName,
  };
}

function sortScopes(scopes: BudgetScope[]): BudgetScope[] {
  return [...scopes].sort((a, b) => {
    const ai = SCOPE_ORDER.indexOf(a.name as (typeof SCOPE_ORDER)[number]);
    const bi = SCOPE_ORDER.indexOf(b.name as (typeof SCOPE_ORDER)[number]);
    const aRank = ai === -1 ? SCOPE_ORDER.length : ai;
    const bRank = bi === -1 ? SCOPE_ORDER.length : bi;
    return aRank - bRank;
  });
}

function resolveScopeKey(scope: BudgetScope, ctx: RunContext | undefined): string | undefined {
  if (scope.name === 'agent' && !ctx) {
    return 'agent';
  }
  if (!ctx) {
    return undefined;
  }

  if (typeof scope.source === 'function') {
    try {
      return scope.source(ctx);
    } catch {
      return undefined;
    }
  }

  if (scope.source === 'agentDef') {
    const name = ctx.agentName ?? 'agent';
    return ctx.runId ? `${name}:${ctx.runId}` : name;
  }

  const value = ctx[scope.source];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (scope.source === 'global') {
    return 'global';
  }

  return undefined;
}

function buildScopeStoreKey(scopeName: string, scopeKey: string): string {
  return `${scopeName}:${scopeKey}`;
}

export function periodBucket(period: BudgetPeriod | undefined, nowMs: number): string | undefined {
  if (!period || period === 'run') {
    return undefined;
  }

  const date = new Date(nowMs);
  switch (period) {
    case 'hour':
      return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}T${date.getUTCHours()}`;
    case 'day':
      return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
    case 'month':
      return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
    default:
      return undefined;
  }
}

function detectBreach(cap: BudgetCap, usage: CurrentUsage): GuardrailBlockCode | undefined {
  if (cap.maxSteps !== undefined && usage.steps > cap.maxSteps) {
    return 'max_steps';
  }
  if (cap.maxTokens !== undefined && usage.tokens > cap.maxTokens) {
    return 'token_budget';
  }
  if (cap.maxCostUsd !== undefined && usage.costUsd > cap.maxCostUsd) {
    return 'cost_budget';
  }
  return undefined;
}

function breachReason(
  scopeName: string,
  code: GuardrailBlockCode,
  usage: CurrentUsage,
  cap: BudgetCap,
  contextLabel: string,
): string {
  switch (code) {
    case 'max_steps':
      return `[${scopeName}] Step budget exceeded: ${usage.steps}/${cap.maxSteps} before ${contextLabel}`;
    case 'token_budget':
      return `[${scopeName}] Token budget exceeded: ${usage.tokens}/${cap.maxTokens} tokens`;
    case 'cost_budget':
      return `[${scopeName}] Cost budget exceeded: $${usage.costUsd.toFixed(4)}/$${cap.maxCostUsd!.toFixed(4)}`;
    default:
      return `[${scopeName}] Budget exceeded before ${contextLabel}`;
  }
}

function toRemaining(usage: CurrentUsage, cap: BudgetCap): RemainingBudget {
  return {
    steps: slice(usage.steps, cap.maxSteps),
    tokens: slice(usage.tokens, cap.maxTokens),
    costUsd: slice(usage.costUsd, cap.maxCostUsd),
  };
}

function slice(used: number, limit?: number): BudgetSlice {
  return {
    used,
    limit,
    remaining: limit !== undefined ? Math.max(0, limit - used) : undefined,
  };
}

function emptyRemaining(): RemainingBudget {
  return {
    steps: { used: 0 },
    tokens: { used: 0 },
    costUsd: { used: 0 },
  };
}

/** Estimate USD cost from token usage and per-1k rates. */
export function estimateCostUsd(usage: TokenUsage, rates: TokenCostRates): number {
  let inputTokens = usage.inputTokens;
  let outputTokens = usage.outputTokens;
  if (inputTokens + outputTokens === 0 && usage.totalTokens > 0) {
    inputTokens = usage.totalTokens;
  }
  const inputCost = (inputTokens / 1000) * rates.inputPer1k;
  const outputCost = (outputTokens / 1000) * rates.outputPer1k;
  return inputCost + outputCost;
}

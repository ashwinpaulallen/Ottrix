import type { TokenUsage } from '../types/provider.js';
import type {
  GuardrailBlockCode,
  GuardrailDecision,
  GuardrailHandler,
  LlmGuardrailContext,
  StatefulGuardrailHandler,
  ToolGuardrailContext,
} from './types.js';

/** Per-1k-token pricing used for cost estimation. */
export interface TokenCostRates {
  /** USD per 1k input tokens. */
  inputPer1k: number;
  /** USD per 1k output tokens. */
  outputPer1k: number;
}

/** Snapshot of remaining budget headroom. */
export interface RemainingBudget {
  steps: BudgetSlice;
  tokens: BudgetSlice;
  costUsd: BudgetSlice;
}

/** Used/limit/remaining for a single budget dimension. */
export interface BudgetSlice {
  used: number;
  limit?: number;
  remaining?: number;
}

/** Options for {@link BudgetGuardrail}. */
export interface BudgetGuardrailOptions {
  maxSteps?: number;
  maxTokenBudget?: number;
  maxCostUsd?: number;
  /** Default rates when no provider-specific entry exists. */
  defaultCostPer1k?: TokenCostRates;
  /** Provider name → cost rates (e.g. `openai`, `anthropic`). */
  costPer1kByProvider?: Record<string, TokenCostRates>;
  /** Provider name used for cost lookup on LLM calls. */
  providerName?: string;
}

/**
 * Tracks step, token, and cost budgets across an agent run.
 * Returns `block` with a human-readable reason when a limit is exceeded.
 */
export class BudgetGuardrail implements GuardrailHandler, StatefulGuardrailHandler {
  readonly name = 'budget';

  private readonly maxSteps?: number;
  private readonly maxTokenBudget?: number;
  private readonly maxCostUsd?: number;
  private readonly defaultCostPer1k: TokenCostRates;
  private readonly costPer1kByProvider: Record<string, TokenCostRates>;
  private readonly providerName?: string;

  private stepCount = 0;
  private totalTokens = 0;
  private totalCostUsd = 0;

  constructor(options: BudgetGuardrailOptions = {}) {
    this.maxSteps = options.maxSteps;
    this.maxTokenBudget = options.maxTokenBudget;
    this.maxCostUsd = options.maxCostUsd;
    this.defaultCostPer1k = options.defaultCostPer1k ?? { inputPer1k: 0.005, outputPer1k: 0.015 };
    this.costPer1kByProvider = options.costPer1kByProvider ?? {};
    this.providerName = options.providerName;
  }

  /** Reset counters (e.g. before a new agent run). */
  reset(): void {
    this.stepCount = 0;
    this.totalTokens = 0;
    this.totalCostUsd = 0;
  }

  /** Current remaining budget for each tracked dimension. */
  getRemainingBudget(): RemainingBudget {
    return {
      steps: slice(this.stepCount, this.maxSteps),
      tokens: slice(this.totalTokens, this.maxTokenBudget),
      costUsd: slice(this.totalCostUsd, this.maxCostUsd),
    };
  }

  beforeLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (context.timing !== 'pre') {
      return Promise.resolve();
    }

    const block = this.checkBudgets('LLM call');
    if (block) {
      return Promise.resolve(block);
    }

    this.stepCount += 1;
    return Promise.resolve();
  }

  afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    if (!context.result?.usage) {
      return Promise.resolve();
    }

    this.recordUsage(context.result.usage, this.providerName);
    return Promise.resolve(this.checkBudgets('LLM call'));
  }

  beforeTool(context: ToolGuardrailContext): Promise<GuardrailDecision | void> {
    if (context.timing !== 'pre') {
      return Promise.resolve();
    }

    return Promise.resolve(this.checkBudgets(`tool "${context.toolName}"`));
  }

  afterTool(): Promise<GuardrailDecision | void> {
    return Promise.resolve();
  }

  /** Record token usage and estimated cost manually. */
  recordUsage(usage: TokenUsage, providerName?: string): void {
    this.totalTokens += usage.totalTokens;
    this.totalCostUsd += estimateCostUsd(usage, this.resolveRates(providerName));
  }

  /** Current usage counters (for syncing with legacy guardrail checks). */
  getUsageSnapshot(): { steps: number; tokens: number; costUsd: number } {
    return {
      steps: this.stepCount,
      tokens: this.totalTokens,
      costUsd: this.totalCostUsd,
    };
  }

  private checkBudgets(contextLabel: string): GuardrailDecision | void {
    if (this.maxSteps !== undefined && this.stepCount >= this.maxSteps) {
      return block(
        'max_steps',
        `Step budget exceeded: ${this.stepCount}/${this.maxSteps} steps used before ${contextLabel}`,
      );
    }

    if (this.maxTokenBudget !== undefined && this.totalTokens >= this.maxTokenBudget) {
      return block(
        'token_budget',
        `Token budget exceeded: ${this.totalTokens}/${this.maxTokenBudget} tokens used`,
      );
    }

    if (this.maxCostUsd !== undefined && this.totalCostUsd >= this.maxCostUsd) {
      return block(
        'cost_budget',
        `Cost budget exceeded: $${this.totalCostUsd.toFixed(4)}/$${this.maxCostUsd.toFixed(4)} estimated`,
      );
    }

    return;
  }

  private resolveRates(providerName?: string): TokenCostRates {
    const named = providerName ? this.costPer1kByProvider[providerName] : undefined;
    if (named) {
      return named;
    }
    return this.defaultCostPer1k;
  }
}

function slice(used: number, limit?: number): BudgetSlice {
  return {
    used,
    limit,
    remaining: limit !== undefined ? Math.max(0, limit - used) : undefined,
  };
}

function block(code: GuardrailBlockCode, reason: string): GuardrailDecision {
  return { action: 'block', code, reason };
}

/** Estimate USD cost from token usage and per-1k rates. */
export function estimateCostUsd(usage: TokenUsage, rates: TokenCostRates): number {
  const inputCost = (usage.inputTokens / 1000) * rates.inputPer1k;
  const outputCost = (usage.outputTokens / 1000) * rates.outputPer1k;
  return inputCost + outputCost;
}

import type { AgentStep } from '../types/agent.js';
import type { GuardrailConfig } from '../types/guardrails.js';
import type { TokenUsage } from '../types/provider.js';

/** Outcome of a guardrail budget check. */
export interface GuardrailCheckResult {
  /** Whether the run should stop. */
  shouldStop: boolean;
  /** Machine-readable stop reason when `shouldStop` is true. */
  stopReason?: 'max_steps' | 'token_budget' | 'cost_budget' | 'guardrail';
  /** Human-readable explanation. */
  message?: string;
}

/** Aggregate token usage across steps. */
export function sumTokenUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

/**
 * Evaluate step and token budgets after a loop iteration.
 */
export function checkRunGuardrails(options: {
  stepIndex: number;
  maxSteps: number;
  totalTokens: TokenUsage;
  maxTokenBudget?: number;
  estimatedCostUsd?: number;
  guardrails?: GuardrailConfig;
  lastStep?: AgentStep;
}): GuardrailCheckResult {
  const {
    stepIndex,
    maxSteps,
    totalTokens,
    maxTokenBudget,
    estimatedCostUsd,
    guardrails,
    lastStep,
  } = options;

  const effectiveMaxSteps = guardrails?.maxSteps ?? maxSteps;
  if (stepIndex >= effectiveMaxSteps) {
    return {
      shouldStop: true,
      stopReason: 'max_steps',
      message: `Maximum steps (${effectiveMaxSteps}) reached`,
    };
  }

  const tokenBudget = guardrails?.maxTokenBudget ?? maxTokenBudget;
  if (tokenBudget !== undefined && totalTokens.totalTokens >= tokenBudget) {
    return {
      shouldStop: true,
      stopReason: 'token_budget',
      message: `Token budget (${tokenBudget}) exceeded (used ${totalTokens.totalTokens})`,
    };
  }

  const costBudget = guardrails?.maxCostUsd;
  if (
    costBudget !== undefined &&
    estimatedCostUsd !== undefined &&
    estimatedCostUsd >= costBudget
  ) {
    return {
      shouldStop: true,
      stopReason: 'cost_budget',
      message: `Cost budget ($${costBudget}) exceeded (estimated $${estimatedCostUsd.toFixed(4)})`,
    };
  }

  if (lastStep && guardrails?.requireApproval?.(lastStep)) {
    return {
      shouldStop: true,
      stopReason: 'guardrail',
      message: 'Human approval required before continuing',
    };
  }

  return { shouldStop: false };
}

import type { AgentResult } from '../types/agent.js';
import type { TokenUsage } from '../types/provider.js';
import { estimateCost, type ProviderCostRates, type ProviderRegistry } from './registry.js';

/** Estimate USD cost from token usage and per-1k rates. */
export function estimateResultCost(usage: TokenUsage, rates: ProviderCostRates): number {
  return estimateCost(usage, rates);
}

/**
 * Estimate USD cost for an agent run using provider pricing from a registry.
 *
 * @param result - Agent result (or any object with `totalTokens`).
 * @param registry - Provider registry that holds cost rates per provider.
 * @param providerName - Registered provider name (e.g. `'anthropic'`).
 */
export function estimateAgentResultCost(
  result: Pick<AgentResult, 'totalTokens'>,
  registry: ProviderRegistry,
  providerName: string,
): number {
  return estimateResultCost(result.totalTokens, registry.getCostRates(providerName));
}

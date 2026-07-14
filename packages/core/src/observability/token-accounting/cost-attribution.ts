import type { TokenBreakdown } from './types.js';

/** Minimal pricing surface used to attach USD costs to a {@link TokenBreakdown}. */
export interface PricingResolver {
  calculate(
    provider: string,
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ): { totalCostUsd: number } | undefined;
}

/** Per-1k token rates for {@link createTokenPricing}. */
export interface TokenPricingRates {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  /** Multiplier on the input rate for cache reads. @defaultValue 0.1 */
  cacheReadMultiplier?: number;
  /** Multiplier on the input rate for cache writes. @defaultValue 1.25 */
  cacheWriteMultiplier?: number;
}

let globalPricing: PricingResolver | undefined;

/** Register (or clear) the global pricing resolver used by agent runs. */
export function useTokenPricing(resolver: PricingResolver | undefined): void {
  globalPricing = resolver;
}

/** Active global {@link PricingResolver}, if any. */
export function getTokenPricing(): PricingResolver | undefined {
  return globalPricing;
}

/**
 * Build a {@link PricingResolver} from per-1k rates.
 *
 * Cache reads are priced at `cacheReadMultiplier` × input rate (default 0.1×).
 * Cache writes are priced at `cacheWriteMultiplier` × input rate (default 1.25×).
 */
export function createTokenPricing(rates: TokenPricingRates): PricingResolver {
  const cacheReadMultiplier = rates.cacheReadMultiplier ?? 0.1;
  const cacheWriteMultiplier = rates.cacheWriteMultiplier ?? 1.25;

  return {
    calculate(_provider, _model, usage) {
      const inputCost = (usage.inputTokens / 1000) * rates.inputPer1kTokens;
      const outputCost = (usage.outputTokens / 1000) * rates.outputPer1kTokens;
      const cacheReadCost =
        ((usage.cacheReadTokens ?? 0) / 1000) * rates.inputPer1kTokens * cacheReadMultiplier;
      const cacheWriteCost =
        ((usage.cacheWriteTokens ?? 0) / 1000) * rates.inputPer1kTokens * cacheWriteMultiplier;
      return {
        totalCostUsd: inputCost + outputCost + cacheReadCost + cacheWriteCost,
      };
    },
  };
}

/**
 * Attach per-capability and total USD costs using a {@link PricingResolver}.
 * When `resolver.calculate` returns `undefined` for a capability, `costUsd` stays unset.
 */
export function attachCosts(
  breakdown: TokenBreakdown,
  resolver: PricingResolver,
  provider: string,
  model: string,
): TokenBreakdown {
  let totalCostUsd = 0;
  let topCapabilityByCost: string | undefined;
  let maxCost = 0;
  let anyCost = false;

  const byCapability = Object.fromEntries(
    Object.entries(breakdown.byCapability).map(([name, usage]) => {
      const cost = resolver.calculate(provider, model, usage);
      const costUsd = cost?.totalCostUsd;

      if (costUsd !== undefined) {
        anyCost = true;
        totalCostUsd += costUsd;
        if (costUsd > maxCost) {
          maxCost = costUsd;
          topCapabilityByCost = name;
        }
      }

      return [name, { ...usage, costUsd }];
    }),
  );

  return {
    ...breakdown,
    byCapability,
    totalCostUsd: anyCost ? totalCostUsd : undefined,
    topCapabilityByCost,
  };
}

/**
 * Attach costs when a pricing resolver is available; otherwise return the breakdown unchanged.
 */
export function enrichBreakdownWithCosts(
  breakdown: TokenBreakdown,
  provider: string,
  model: string,
  resolver: PricingResolver | undefined = getTokenPricing(),
): TokenBreakdown {
  if (!resolver || !provider || !model) {
    return breakdown;
  }
  return attachCosts(breakdown, resolver, provider, model);
}

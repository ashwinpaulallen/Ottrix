import type { ChatMessage } from '../types/messages.js';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  StreamChunk,
  TokenUsage,
} from '../types/provider.js';
import { instrumentProvider } from '../observability/instrument.js';
import type { Telemetry } from '../observability/telemetry.js';
import {
  FallbackExecutor,
  normalizeFallbackChain,
  type FallbackChainEntry,
  type FallbackChainInput,
  type FallbackExecutionEvent,
} from './fallback-executor.js';
import { CircuitOpenError } from './circuit-breaker.js';
import { ProviderError } from './errors.js';

/** Relative cost tier for provider capability matching and estimates. */
export type CostTier = 'free' | 'low' | 'medium' | 'high';

/** Per-1k-token pricing used for cost aggregation (USD). */
export interface ProviderCostRates {
  /** USD per 1,000 input tokens. */
  inputPer1kTokens: number;
  /** USD per 1,000 output tokens. */
  outputPer1kTokens: number;
}

/**
 * Declared capabilities for a registered provider.
 */
export interface ProviderCapabilities {
  /** Whether the provider supports tool / function calling. */
  supportsTools?: boolean;
  /** Whether streaming completions are supported. */
  supportsStreaming?: boolean;
  /** Whether image / vision inputs are supported. */
  supportsVision?: boolean;
  /** Relative cost tier for auto-selection. */
  costTier?: CostTier;
  /** Typical latency class. */
  latency?: 'fast' | 'medium' | 'slow';
  /** Approximate maximum context window in tokens. */
  maxContextTokens?: number;
}

/**
 * Criteria for {@link ProviderRegistry.selectProvider}.
 */
export interface ProviderSelectionCriteria {
  /** Require tool-calling support. */
  needsTools?: boolean;
  /** Require streaming support. */
  needsStreaming?: boolean;
  /** Require vision / image input support. */
  needsVision?: boolean;
  /** Maximum acceptable cost tier (inclusive). */
  maxCost?: CostTier;
  /** Prefer the lowest-latency provider among matches. */
  preferLowLatency?: boolean;
}

/** Options when registering a provider. */
export interface ProviderRegistrationOptions {
  /** Capability metadata for routing and selection. */
  capabilities?: ProviderCapabilities;
  /** Optional explicit pricing; otherwise inferred from `costTier`. */
  costRates?: ProviderCostRates;
}

/** Backoff settings between fallback provider attempts (legacy global default). */
export interface FallbackBackoffOptions {
  /** Base delay in ms before the first fallback. @defaultValue 500 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. @defaultValue 30000 */
  maxDelayMs?: number;
  /** Maximum random jitter added in ms. @defaultValue 250 */
  maxJitterMs?: number;
  /** Random source (for tests). @defaultValue `Math.random` */
  random?: () => number;
}

/** Observability payload when falling back to another provider (legacy). */
export interface ProviderFallbackEvent {
  event: 'provider_fallback';
  from: string;
  to: string;
  reason: string;
}

/** Constructor options for {@link ProviderRegistry}. */
export interface ProviderRegistryOptions {
  /** Consecutive failures before marking a provider unhealthy. @defaultValue 3 */
  unhealthyFailureThreshold?: number;
  /** Optional telemetry for instrumented providers. */
  telemetry?: Telemetry;
  /** Legacy global backoff defaults for string-only chains. */
  fallbackBackoff?: FallbackBackoffOptions;
  /** Invoked when the registry switches to the next provider (legacy). */
  onProviderFallback?: (event: ProviderFallbackEvent) => void;
  /** Invoked for each retry, fallback, success, or exhausted event. */
  onFallbackEvent?: (event: FallbackExecutionEvent) => void;
  /** Injectable sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (for tests). */
  now?: () => number;
  /** Injectable random (for tests). */
  random?: () => number;
}

/** Internal health state for a provider. */
interface ProviderHealthState {
  healthy: boolean;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
}

/** Registered provider entry. */
interface RegisteredProvider {
  name: string;
  provider: CompletionProvider;
  /** Provider instance before telemetry instrumentation (for circuit state). */
  sourceProvider: CompletionProvider;
  capabilities: ProviderCapabilities;
  costRates: ProviderCostRates;
  health: ProviderHealthState;
}

/** Per-provider aggregated usage. */
export interface ProviderUsageTotals {
  /** Provider name. */
  provider: string;
  /** Cumulative input tokens. */
  inputTokens: number;
  /** Cumulative output tokens. */
  outputTokens: number;
  /** Cumulative total tokens. */
  totalTokens: number;
  /** Estimated cumulative cost in USD. */
  estimatedCostUsd: number;
  /** Successful completion count recorded. */
  requestCount: number;
}

/** Registry-wide cost and usage summary. */
export interface RegistryCostSummary {
  /** Sum of input tokens across providers. */
  totalInputTokens: number;
  /** Sum of output tokens across providers. */
  totalOutputTokens: number;
  /** Sum of total tokens across providers. */
  totalTokens: number;
  /** Estimated total cost in USD. */
  totalEstimatedCostUsd: number;
  /** Per-provider breakdown. */
  byProvider: Record<string, ProviderUsageTotals>;
}

/** Default USD rates per 1k tokens by cost tier. */
const DEFAULT_COST_RATES: Record<CostTier, ProviderCostRates> = {
  free: { inputPer1kTokens: 0, outputPer1kTokens: 0 },
  low: { inputPer1kTokens: 0.000_15, outputPer1kTokens: 0.000_6 },
  medium: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  high: { inputPer1kTokens: 0.01, outputPer1kTokens: 0.03 },
};

const COST_TIER_ORDER: Record<CostTier, number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const LATENCY_ORDER: Record<NonNullable<ProviderCapabilities['latency']>, number> = {
  fast: 0,
  medium: 1,
  slow: 2,
};

export type {
  FallbackChainEntry,
  FallbackChainInput,
  FallbackChainBackoffConfig,
  FallbackExecutionEvent,
  ErrorDisposition,
} from './fallback-executor.js';

export {
  classifyProviderError,
  computeProviderBackoffMs,
  computeFallbackBackoffMs,
  isProviderCircuitOpen,
  isProviderRequestBlocked,
  shouldTryFallback,
  normalizeFallbackChain,
} from './fallback-executor.js';

/**
 * Multi-provider registry with fallback chains, health tracking, selection, and cost aggregation.
 *
 * Implements {@link CompletionProvider} by delegating to the configured fallback chain or default
 * provider.
 */
export class ProviderRegistry implements CompletionProvider {
  private readonly providers = new Map<string, RegisteredProvider>();
  private defaultProviderName?: string;
  private fallbackChain: FallbackChainEntry[] = [];
  private readonly unhealthyFailureThreshold: number;
  private readonly telemetry?: Telemetry;
  private readonly fallbackBackoff: FallbackBackoffOptions;
  private readonly onProviderFallback?: (event: ProviderFallbackEvent) => void;
  private readonly onFallbackEvent?: (event: FallbackExecutionEvent) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly executor: FallbackExecutor;

  /**
   * @param options - Optional health thresholds, telemetry, and fallback backoff.
   */
  constructor(options?: ProviderRegistryOptions) {
    this.unhealthyFailureThreshold = options?.unhealthyFailureThreshold ?? 3;
    this.telemetry = options?.telemetry;
    this.fallbackBackoff = options?.fallbackBackoff ?? {};
    this.onProviderFallback = options?.onProviderFallback;
    this.onFallbackEvent = options?.onFallbackEvent;
    this.sleep = options?.sleep ?? defaultSleep;
    this.now = options?.now ?? Date.now;
    this.random = options?.random ?? Math.random;

    this.executor = new FallbackExecutor({
      resolveProvider: (name) => {
        const entry = this.getEntry(name);
        return {
          name: entry.name,
          provider: entry.provider,
          sourceProvider: entry.sourceProvider,
          healthy: entry.health.healthy,
        };
      },
      recordSuccess: (name) => this.recordSuccess(name),
      recordFailure: (name) => this.recordFailure(name),
      recordUsage: (name, usage) => this.recordUsage(name, usage),
      telemetry: this.telemetry,
      sleep: this.sleep,
      now: this.now,
      random: this.random,
      onEvent: (event) => {
        this.onFallbackEvent?.(event);
        if (event.type === 'fallback' && event.toProvider) {
          this.onProviderFallback?.({
            event: 'provider_fallback',
            from: event.provider,
            to: event.toProvider,
            reason: fallbackReasonFromError(event.error),
          });
        }
      },
    });
  }

  /**
   * Register a completion provider by unique name.
   *
   * @param name - Registry key (e.g. `"anthropic"`).
   * @param provider - Provider instance.
   * @param options - Capabilities and optional pricing.
   */
  register(
    name: string,
    provider: CompletionProvider,
    options: ProviderRegistrationOptions = {},
  ): this {
    const capabilities = options.capabilities ?? {};
    const costTier = capabilities.costTier ?? 'medium';
    const resolvedProvider = this.telemetry
      ? instrumentProvider(provider, this.telemetry, { component: name })
      : provider;
    this.providers.set(name, {
      name,
      provider: resolvedProvider,
      sourceProvider: provider,
      capabilities,
      costRates: options.costRates ?? DEFAULT_COST_RATES[costTier],
      health: {
        healthy: true,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
      },
    });
    return this;
  }

  /**
   * Retrieve a registered provider by name.
   *
   * @throws If the name is not registered.
   */
  get(name: string): CompletionProvider {
    const entry = this.providers.get(name);
    if (!entry) {
      throw new ProviderError(`Provider "${name}" is not registered`, {
        code: 'unknown',
        retryable: false,
      });
    }
    return entry.provider;
  }

  /**
   * Set the default provider used when no fallback chain is configured.
   *
   * @throws If the name is not registered.
   */
  setDefault(name: string): this {
    this.assertRegistered(name);
    this.defaultProviderName = name;
    return this;
  }

  /**
   * Configure an ordered fallback chain for {@link ProviderRegistry.complete},
   * {@link ProviderRegistry.stream}, and {@link ProviderRegistry.countTokens}.
   *
   * Accepts provider names or detailed per-provider retry/backoff config.
   */
  setFallbackChain(chain: FallbackChainInput[]): this {
    const normalized = normalizeFallbackChain(chain);
    for (const step of normalized) {
      this.assertRegistered(step.provider);
    }
    this.fallbackChain = normalized.map((step) => this.applyLegacyBackoffDefaults(step));
    return this;
  }

  /**
   * Mark a provider as healthy or unhealthy (e.g. after external health checks).
   */
  setHealthy(name: string, healthy: boolean): this {
    const entry = this.getEntry(name);
    entry.health.healthy = healthy;
    if (healthy) entry.health.consecutiveFailures = 0;
    return this;
  }

  /**
   * Whether a provider is currently considered healthy.
   */
  isHealthy(name: string): boolean {
    return this.getEntry(name).health.healthy;
  }

  /**
   * Select the best registered provider for the given criteria.
   *
   * @throws If no healthy provider matches.
   */
  selectProvider(criteria: ProviderSelectionCriteria = {}): CompletionProvider {
    const name = this.selectProviderName(criteria);
    return this.get(name);
  }

  /**
   * Select a provider name matching criteria (for logging / metrics).
   */
  selectProviderName(criteria: ProviderSelectionCriteria = {}): string {
    const candidates = [...this.providers.values()].filter(
      (entry) => entry.health.healthy && matchesCriteria(entry.capabilities, criteria),
    );

    if (candidates.length === 0) {
      throw new ProviderError('No healthy provider matches the selection criteria', {
        code: 'unknown',
        retryable: false,
      });
    }

    candidates.sort((a, b) => compareCandidates(a, b, criteria));
    return candidates[0].name;
  }

  /**
   * Aggregate token usage and estimated cost across all providers.
   */
  getCostSummary(): RegistryCostSummary {
    const byProvider: Record<string, ProviderUsageTotals> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalEstimatedCostUsd = 0;

    for (const [name] of this.providers) {
      const usage = this.usageTotals.get(name);
      if (!usage) continue;
      byProvider[name] = { provider: name, ...usage };
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalTokens += usage.totalTokens;
      totalEstimatedCostUsd += usage.estimatedCostUsd;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalEstimatedCostUsd,
      byProvider,
    };
  }

  /** Reset all cost and usage counters. */
  resetCostTracking(): void {
    this.usageTotals.clear();
  }

  /** @inheritdoc — uses fallback chain or default provider. */
  async complete(params: CompletionParams): Promise<CompletionResult> {
    const chain = this.resolveExecutionChain();
    const { result, metadata } = await this.executor.executeComplete(params, chain);
    return {
      ...result,
      metadata: {
        ...result.metadata,
        ...metadata,
      },
    };
  }

  /** @inheritdoc — uses fallback chain; only falls back before the first chunk. */
  stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    const chain = this.resolveExecutionChain();
    return this.executor.executeStream(params, chain);
  }

  /** @inheritdoc — uses fallback chain or default provider. */
  async countTokens(messages: ChatMessage[]): Promise<number> {
    const chain = this.resolveExecutionChain();
    return this.executor.executeCountTokens(messages, chain);
  }

  private readonly usageTotals = new Map<string, Omit<ProviderUsageTotals, 'provider'>>();

  private getEntry(name: string): RegisteredProvider {
    const entry = this.providers.get(name);
    if (!entry) {
      throw new ProviderError(`Provider "${name}" is not registered`, {
        code: 'unknown',
        retryable: false,
      });
    }
    return entry;
  }

  private assertRegistered(name: string): void {
    if (!this.providers.has(name)) {
      throw new ProviderError(`Provider "${name}" is not registered`, {
        code: 'unknown',
        retryable: false,
      });
    }
  }

  private resolveExecutionChain(): FallbackChainEntry[] {
    if (this.fallbackChain.length > 0) return this.fallbackChain;
    if (this.defaultProviderName) {
      return [{ provider: this.defaultProviderName }];
    }
    throw new ProviderError('No default provider or fallback chain configured', {
      code: 'unknown',
      retryable: false,
    });
  }

  /** Apply registry-level backoff defaults to string-only chain entries. */
  private applyLegacyBackoffDefaults(step: FallbackChainEntry): FallbackChainEntry {
    if (step.backoff) return step;
    const { baseDelayMs, maxDelayMs } = this.fallbackBackoff;
    if (baseDelayMs === undefined && maxDelayMs === undefined) return step;
    return {
      ...step,
      backoff: {
        base: baseDelayMs,
        max: maxDelayMs,
        jitter: (this.fallbackBackoff.maxJitterMs ?? 250) > 0,
      },
    };
  }

  private recordSuccess(name: string): void {
    const health = this.getEntry(name).health;
    health.successCount += 1;
    health.consecutiveFailures = 0;
    health.healthy = true;
  }

  private recordFailure(name: string): void {
    const health = this.getEntry(name).health;
    health.failureCount += 1;
    health.consecutiveFailures += 1;
    if (health.consecutiveFailures >= this.unhealthyFailureThreshold) {
      health.healthy = false;
    }
  }

  private recordUsage(name: string, usage: TokenUsage): void {
    const entry = this.getEntry(name);
    const cost = estimateCost(usage, entry.costRates);
    const current = this.usageTotals.get(name) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      requestCount: 0,
    };

    this.usageTotals.set(name, {
      inputTokens: current.inputTokens + usage.inputTokens,
      outputTokens: current.outputTokens + usage.outputTokens,
      totalTokens: current.totalTokens + usage.totalTokens,
      estimatedCostUsd: current.estimatedCostUsd + cost,
      requestCount: current.requestCount + 1,
    });
  }
}

/** Estimate USD cost from token usage and rates. */
export function estimateCost(usage: TokenUsage, rates: ProviderCostRates): number {
  return (
    (usage.inputTokens / 1000) * rates.inputPer1kTokens +
    (usage.outputTokens / 1000) * rates.outputPer1kTokens
  );
}

function matchesCriteria(
  capabilities: ProviderCapabilities,
  criteria: ProviderSelectionCriteria,
): boolean {
  if (criteria.needsTools && !capabilities.supportsTools) return false;
  if (criteria.needsStreaming && !capabilities.supportsStreaming) return false;
  if (criteria.needsVision && !capabilities.supportsVision) return false;
  if (criteria.maxCost !== undefined) {
    const tier = capabilities.costTier ?? 'medium';
    if (COST_TIER_ORDER[tier] > COST_TIER_ORDER[criteria.maxCost]) return false;
  }
  return true;
}

function compareCandidates(
  a: RegisteredProvider,
  b: RegisteredProvider,
  criteria: ProviderSelectionCriteria,
): number {
  const costA = COST_TIER_ORDER[a.capabilities.costTier ?? 'medium'];
  const costB = COST_TIER_ORDER[b.capabilities.costTier ?? 'medium'];
  if (costA !== costB) return costA - costB;

  if (criteria.preferLowLatency) {
    const latA = LATENCY_ORDER[a.capabilities.latency ?? 'medium'];
    const latB = LATENCY_ORDER[b.capabilities.latency ?? 'medium'];
    if (latA !== latB) return latA - latB;
  }

  return a.name.localeCompare(b.name);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fallbackReasonFromError(error?: Error): string {
  if (!error) return 'fallback';
  if (CircuitOpenError.isCircuitOpenError(error)) return 'circuit_open';
  if (ProviderError.isProviderError(error)) return error.code;
  return 'error';
}

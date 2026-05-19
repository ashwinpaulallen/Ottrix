import type { ChatMessage } from '../types/messages.js';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  CompletionResultMetadata,
  StreamChunk,
  TokenUsage,
} from '../types/provider.js';
import type { Telemetry } from '../observability/telemetry.js';
import { BaseProvider } from './base.js';
import { CircuitOpenError } from './circuit-breaker.js';
import {
  AggregateProviderError,
  ProviderError,
  type AggregateProviderAttempt,
} from './errors.js';

/** Backoff settings for retries on a single provider. */
export interface FallbackChainBackoffConfig {
  /** Base delay in ms. @defaultValue 500 */
  base?: number;
  /** Maximum delay cap in ms. @defaultValue 30000 */
  max?: number;
  /** Whether to add random jitter. @defaultValue true */
  jitter?: boolean;
}

/** One step in a configured fallback chain. */
export interface FallbackChainEntry {
  /** Registered provider name. */
  provider: string;
  /**
   * Additional attempts after the first try (0 = one attempt total).
   * @defaultValue 0
   */
  retries?: number;
  /** Per-provider retry backoff overrides. */
  backoff?: FallbackChainBackoffConfig;
}

/** Shorthand accepted by {@link normalizeFallbackChain}. */
export type FallbackChainInput = string | FallbackChainEntry;

/** How a provider error should be handled in the fallback chain. */
export type ErrorDisposition = 'retry' | 'fallback' | 'terminal';

/** Event emitted at each step of fallback execution. */
export interface FallbackExecutionEvent {
  type: 'retry' | 'fallback' | 'success' | 'exhausted';
  provider: string;
  attempt: number;
  error?: Error;
  /** Target provider when `type` is `fallback`. */
  toProvider?: string;
}

/** Provider entry resolved for execution. */
export interface FallbackProviderContext {
  name: string;
  provider: CompletionProvider;
  sourceProvider: CompletionProvider;
  healthy: boolean;
}

/** Dependencies injected into {@link FallbackExecutor}. */
export interface FallbackExecutorDeps {
  resolveProvider: (name: string) => FallbackProviderContext;
  recordSuccess: (name: string) => void;
  recordFailure: (name: string) => void;
  recordUsage?: (name: string, usage: TokenUsage) => void;
  telemetry?: Telemetry;
  onEvent?: (event: FallbackExecutionEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Result of a successful completion through the fallback chain. */
export interface FallbackCompletionOutcome {
  result: CompletionResult;
  metadata: CompletionResultMetadata;
}

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_JITTER_FRACTION = 0.25;

/**
 * Normalize shorthand chain entries (`"openai"`) into full config objects.
 */
export function normalizeFallbackChain(chain: FallbackChainInput[]): FallbackChainEntry[] {
  return chain.map((item) => (typeof item === 'string' ? { provider: item } : item));
}

/**
 * Classify a provider error for retry vs fallback vs terminal handling.
 */
export function classifyProviderError(
  error: unknown,
  options: { retriesRemaining: number } = { retriesRemaining: 0 },
): ErrorDisposition {
  if (CircuitOpenError.isCircuitOpenError(error)) {
    return 'fallback';
  }

  if (!ProviderError.isProviderError(error)) {
    return 'terminal';
  }

  switch (error.code) {
    case 'rate_limit':
    case 'server_error':
    case 'timeout':
      return options.retriesRemaining > 0 ? 'retry' : 'fallback';
    case 'context_length':
    case 'content_filter':
    case 'auth':
      return 'fallback';
    case 'invalid_request':
      return 'terminal';
    case 'unknown':
      if (isHttpStatus(error, 400)) return 'terminal';
      return error.retryable && options.retriesRemaining > 0 ? 'retry' : 'fallback';
    default:
      return error.retryable && options.retriesRemaining > 0 ? 'retry' : 'fallback';
  }
}

/**
 * Compute exponential backoff for a provider retry attempt.
 */
export function computeProviderBackoffMs(
  attempt: number,
  config: FallbackChainBackoffConfig = {},
  random: () => number = Math.random,
): number {
  const base = config.base ?? DEFAULT_BACKOFF_BASE_MS;
  const max = config.max ?? DEFAULT_BACKOFF_MAX_MS;
  const exponential = Math.min(base * 2 ** attempt, max);

  if (config.jitter === false) {
    return exponential;
  }

  const jitter = random() * max * DEFAULT_JITTER_FRACTION;
  return Math.min(exponential + jitter, max);
}

/** Whether a registered provider's circuit breaker is in the OPEN state. */
export function isProviderCircuitOpen(provider: CompletionProvider): boolean {
  if (provider instanceof BaseProvider) {
    return provider.isCircuitOpen();
  }
  return false;
}

/** Whether a provider would reject a new request (open circuit or half-open saturated). */
export function isProviderRequestBlocked(provider: CompletionProvider): boolean {
  if (provider instanceof BaseProvider) {
    return provider.isRequestBlocked();
  }
  return false;
}

function circuitOpenErrorForProvider(providerName: string, source: CompletionProvider): CircuitOpenError {
  const retryAfterMs =
    source instanceof BaseProvider ? source.getCircuitRetryAfterMs() : 0;
  return new CircuitOpenError(
    `Circuit breaker is open for provider "${providerName}".`,
    providerName,
    retryAfterMs,
  );
}

function throwChainExhausted(aggregate: AggregateProviderAttempt[]): never {
  if (aggregate.length === 0) {
    throw new AggregateProviderError(
      aggregate,
      'No providers available in the fallback chain (all skipped, unhealthy, or blocked).',
    );
  }
  throw new AggregateProviderError(aggregate);
}

/**
 * Walks a fallback chain with per-provider retries, backoff, and error classification.
 */
export class FallbackExecutor {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  /**
   * @param deps - Registry hooks, telemetry, and optional test doubles.
   */
  constructor(private readonly deps: FallbackExecutorDeps) {
    this.sleep = deps.sleep ?? sleep;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  /**
   * Execute a non-streaming completion through the chain.
   */
  async executeComplete(
    params: CompletionParams,
    chain: FallbackChainEntry[],
  ): Promise<FallbackCompletionOutcome> {
    const startedAt = this.now();
    const aggregate: AggregateProviderAttempt[] = [];
    let fallbacksTriggered = 0;

    for (let chainIndex = 0; chainIndex < chain.length; chainIndex += 1) {
      const step = chain[chainIndex];
      const ctx = this.deps.resolveProvider(step.provider);
      const nextStep = chain[chainIndex + 1];

      if (!ctx.healthy) {
        continue;
      }

      if (isProviderRequestBlocked(ctx.sourceProvider)) {
        const circuitError = circuitOpenErrorForProvider(step.provider, ctx.sourceProvider);
        const attempts = [toProviderError(circuitError)];
        aggregate.push({ provider: step.provider, attempts });
        this.recordErrorTelemetry(step.provider, circuitError);

        if (!nextStep) {
          this.emit({ type: 'exhausted', provider: step.provider, attempt: 0, error: circuitError });
          throw new AggregateProviderError(aggregate);
        }

        this.emit({
          type: 'fallback',
          provider: step.provider,
          attempt: 0,
          error: circuitError,
          toProvider: nextStep.provider,
        });
        fallbacksTriggered += 1;
        continue;
      }

      const maxAttempts = 1 + (step.retries ?? 0);
      const providerAttempts: ProviderError[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const retriesRemaining = maxAttempts - attempt;

        try {
          const result = await ctx.provider.complete(params);
          this.deps.recordSuccess(step.provider);
          this.deps.recordUsage?.(step.provider, result.usage);

          this.emit({ type: 'success', provider: step.provider, attempt });

          return {
            result,
            metadata: {
              provider: step.provider,
              attempt,
              fallbacksTriggered,
              totalLatencyMs: this.now() - startedAt,
            },
          };
        } catch (error) {
          const recorded = toProviderError(error);
          const eventError = error instanceof Error ? error : recorded;
          providerAttempts.push(recorded);
          this.deps.recordFailure(step.provider);
          this.recordErrorTelemetry(step.provider, error);

          const disposition = classifyProviderError(error, { retriesRemaining });

          if (disposition === 'terminal') {
            this.emit({ type: 'exhausted', provider: step.provider, attempt, error: eventError });
            aggregate.push({ provider: step.provider, attempts: providerAttempts });
            throw new AggregateProviderError(aggregate);
          }

          if (disposition === 'retry') {
            this.emit({ type: 'retry', provider: step.provider, attempt, error: eventError });
            const delayMs = computeProviderBackoffMs(attempt - 1, step.backoff, this.random);
            await this.sleep(delayMs);
            continue;
          }

          // fallback disposition
          aggregate.push({ provider: step.provider, attempts: providerAttempts });

          if (!nextStep) {
            this.emit({ type: 'exhausted', provider: step.provider, attempt, error: eventError });
            throw new AggregateProviderError(aggregate);
          }

          this.emit({
            type: 'fallback',
            provider: step.provider,
            attempt,
            error: eventError,
            toProvider: nextStep.provider,
          });
          fallbacksTriggered += 1;
          break;
        }
      }
    }

    throwChainExhausted(aggregate);
  }

  /**
   * Stream through the chain; only retries / falls back before the first chunk.
   */
  async *executeStream(
    params: CompletionParams,
    chain: FallbackChainEntry[],
  ): AsyncGenerator<StreamChunk> {
    const aggregate: AggregateProviderAttempt[] = [];

    for (let chainIndex = 0; chainIndex < chain.length; chainIndex += 1) {
      const step = chain[chainIndex];
      const ctx = this.deps.resolveProvider(step.provider);
      const nextStep = chain[chainIndex + 1];

      if (!ctx.healthy) continue;

      if (isProviderRequestBlocked(ctx.sourceProvider)) {
        const circuitError = circuitOpenErrorForProvider(step.provider, ctx.sourceProvider);
        aggregate.push({ provider: step.provider, attempts: [toProviderError(circuitError)] });
        this.recordErrorTelemetry(step.provider, circuitError);

        if (!nextStep) {
          this.emit({ type: 'exhausted', provider: step.provider, attempt: 0, error: circuitError });
          throw new AggregateProviderError(aggregate);
        }

        this.emit({
          type: 'fallback',
          provider: step.provider,
          attempt: 0,
          error: circuitError,
          toProvider: nextStep.provider,
        });
        continue;
      }

      const maxAttempts = 1 + (step.retries ?? 0);
      const providerAttempts: ProviderError[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const retriesRemaining = maxAttempts - attempt;
        let receivedChunk = false;

        try {
          for await (const chunk of ctx.provider.stream(params)) {
            receivedChunk = true;
            yield chunk;
            if (chunk.type === 'done' && chunk.data && typeof chunk.data === 'object') {
              const data = chunk.data as { usage?: TokenUsage };
              if (data.usage) this.deps.recordUsage?.(step.provider, data.usage);
            }
          }

          this.deps.recordSuccess(step.provider);
          this.emit({ type: 'success', provider: step.provider, attempt });
          return;
        } catch (error) {
          const recorded = toProviderError(error);
          const eventError = error instanceof Error ? error : recorded;
          providerAttempts.push(recorded);
          this.deps.recordFailure(step.provider);
          this.recordErrorTelemetry(step.provider, error);

          if (receivedChunk) {
            throw recorded;
          }

          const disposition = classifyProviderError(error, { retriesRemaining });

          if (disposition === 'terminal') {
            this.emit({ type: 'exhausted', provider: step.provider, attempt, error: eventError });
            aggregate.push({ provider: step.provider, attempts: providerAttempts });
            throw new AggregateProviderError(aggregate);
          }

          if (disposition === 'retry') {
            this.emit({ type: 'retry', provider: step.provider, attempt, error: eventError });
            const delayMs = computeProviderBackoffMs(attempt - 1, step.backoff, this.random);
            await this.sleep(delayMs);
            continue;
          }

          aggregate.push({ provider: step.provider, attempts: providerAttempts });

          if (!nextStep) {
            this.emit({ type: 'exhausted', provider: step.provider, attempt, error: eventError });
            throw new AggregateProviderError(aggregate);
          }

          this.emit({
            type: 'fallback',
            provider: step.provider,
            attempt,
            error: eventError,
            toProvider: nextStep.provider,
          });
          break;
        }
      }
    }

    throwChainExhausted(aggregate);
  }

  /**
   * Count tokens through the chain (same retry / fallback semantics as complete).
   */
  async executeCountTokens(
    messages: ChatMessage[],
    chain: FallbackChainEntry[],
  ): Promise<number> {
    const aggregate: AggregateProviderAttempt[] = [];

    for (let chainIndex = 0; chainIndex < chain.length; chainIndex += 1) {
      const step = chain[chainIndex];
      const ctx = this.deps.resolveProvider(step.provider);
      const nextStep = chain[chainIndex + 1];

      if (!ctx.healthy) continue;

      if (isProviderRequestBlocked(ctx.sourceProvider)) {
        const circuitError = circuitOpenErrorForProvider(step.provider, ctx.sourceProvider);
        aggregate.push({ provider: step.provider, attempts: [toProviderError(circuitError)] });

        if (!nextStep) {
          throwChainExhausted(aggregate);
        }
        continue;
      }

      const maxAttempts = 1 + (step.retries ?? 0);
      const providerAttempts: ProviderError[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const retriesRemaining = maxAttempts - attempt;

        try {
          const count = await ctx.provider.countTokens(messages);
          this.deps.recordSuccess(step.provider);
          this.emit({ type: 'success', provider: step.provider, attempt });
          return count;
        } catch (error) {
          const recorded = toProviderError(error);
          const eventError = error instanceof Error ? error : recorded;
          providerAttempts.push(recorded);
          this.deps.recordFailure(step.provider);
          this.recordErrorTelemetry(step.provider, error);

          const disposition = classifyProviderError(error, { retriesRemaining });

          if (disposition === 'terminal') {
            aggregate.push({ provider: step.provider, attempts: providerAttempts });
            throw new AggregateProviderError(aggregate);
          }

          if (disposition === 'retry') {
            this.emit({ type: 'retry', provider: step.provider, attempt, error: eventError });
            await this.sleep(computeProviderBackoffMs(attempt - 1, step.backoff, this.random));
            continue;
          }

          aggregate.push({ provider: step.provider, attempts: providerAttempts });

          if (!nextStep) {
            throwChainExhausted(aggregate);
          }

          this.emit({
            type: 'fallback',
            provider: step.provider,
            attempt,
            error: eventError,
            toProvider: nextStep.provider,
          });
          break;
        }
      }
    }

    throwChainExhausted(aggregate);
  }

  private emit(event: FallbackExecutionEvent): void {
    this.deps.telemetry?.recordProviderChainEvent({
      type: event.type,
      provider: event.provider,
      attempt: event.attempt,
      toProvider: event.toProvider,
      error: event.error,
    });
    this.deps.onEvent?.(event);
  }

  private recordErrorTelemetry(provider: string, error: unknown): void {
    this.deps.telemetry?.trackProviderError(provider, errorCodeForTelemetry(error));
  }
}

/** Coerce errors to {@link ProviderError} for aggregate storage. */
export function toProviderError(error: unknown): ProviderError {
  if (ProviderError.isProviderError(error)) {
    return error;
  }

  if (CircuitOpenError.isCircuitOpenError(error)) {
    return new ProviderError(error.message, {
      code: 'server_error',
      retryable: true,
      originalError: error,
    });
  }

  if (error instanceof Error) {
    return new ProviderError(error.message, { code: 'unknown', retryable: false, originalError: error });
  }

  return new ProviderError(String(error), { code: 'unknown', retryable: false, originalError: error });
}

function errorCodeForTelemetry(error: unknown): string {
  if (CircuitOpenError.isCircuitOpenError(error)) return 'circuit_open';
  if (ProviderError.isProviderError(error)) return error.code;
  return 'unknown';
}

function isHttpStatus(error: ProviderError, status: number): boolean {
  const original = error.originalError;
  if (typeof original === 'object' && original !== null && 'status' in original) {
    return (original as { status: number }).status === status;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @deprecated Use {@link classifyProviderError} instead.
 */
export function shouldTryFallback(error: unknown): boolean {
  return classifyProviderError(error, { retriesRemaining: 1 }) !== 'terminal';
}

/**
 * @deprecated Use {@link computeProviderBackoffMs} instead.
 */
export function computeFallbackBackoffMs(
  attempt: number,
  options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxJitterMs?: number;
    random?: () => number;
  } = {},
): number {
  const random = options.random ?? Math.random;
  const maxJitterMs = options.maxJitterMs ?? 250;
  const base = options.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxDelayMs ?? DEFAULT_BACKOFF_MAX_MS;
  const exponential = Math.min(base * 2 ** attempt, max);
  if (maxJitterMs <= 0) {
    return exponential;
  }
  return Math.min(exponential + random() * maxJitterMs, max);
}

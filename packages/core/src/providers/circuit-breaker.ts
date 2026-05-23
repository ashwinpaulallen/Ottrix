/** Circuit breaker lifecycle states. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Configuration for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. @defaultValue 5 */
  failureThreshold?: number;
  /** Time before transitioning from OPEN to HALF_OPEN (ms). @defaultValue 60000 */
  resetTimeoutMs?: number;
  /** Max concurrent requests allowed in HALF_OPEN (probe limit). @defaultValue 1 */
  halfOpenMaxAttempts?: number;
  /** Provider name included in {@link CircuitOpenError}. */
  provider?: string;
  /** Clock for testing. @defaultValue `Date.now` */
  now?: () => number;
}

/** Runtime statistics for a circuit breaker. */
export interface CircuitBreakerStats {
  failures: number;
  successes: number;
  state: CircuitState;
  lastFailure?: Date;
}

/**
 * Thrown when a request is rejected because the circuit is OPEN.
 */
export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError';

  /**
   * @param message - Human-readable description.
   * @param provider - Provider identifier associated with the circuit.
   * @param retryAfterMs - Suggested wait before retrying this provider.
   */
  constructor(
    message: string,
    readonly provider: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }

  /** Type guard for {@link CircuitOpenError}. */
  static isCircuitOpenError(error: unknown): error is CircuitOpenError {
    return error instanceof CircuitOpenError;
  }
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 60_000;
const DEFAULT_HALF_OPEN_MAX_ATTEMPTS = 1;

/**
 * Circuit breaker with CLOSED, OPEN, and HALF_OPEN states.
 *
 * Prevents hammering a provider that is clearly down.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private openedAtMs?: number;
  private lastFailureAt?: Date;
  private halfOpenInFlight = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly provider: string;
  private readonly now: () => number;

  /**
   * @param options - Thresholds, timeouts, and provider label.
   */
  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? DEFAULT_HALF_OPEN_MAX_ATTEMPTS;
    this.provider = options.provider ?? 'unknown';
    this.now = options.now ?? Date.now;
  }

  /** Current circuit state (may transition OPEN → HALF_OPEN when timeout elapses). */
  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  /** Snapshot of breaker statistics. */
  getStats(): CircuitBreakerStats {
    this.maybeTransitionToHalfOpen();
    return {
      failures: this.totalFailures,
      successes: this.totalSuccesses,
      state: this.state,
      lastFailure: this.lastFailureAt,
    };
  }

  /** Force the circuit back to CLOSED and clear counters. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAtMs = undefined;
    this.halfOpenInFlight = 0;
  }

  /**
   * Assert the circuit allows a request (throws when OPEN).
   *
   * Pair with {@link CircuitBreaker.afterRequest} for streaming paths.
   */
  beforeRequest(): void {
    this.maybeTransitionToHalfOpen();

    if (this.state === 'open') {
      throw this.createOpenError();
    }

    if (this.state === 'half_open') {
      if (this.halfOpenInFlight >= this.halfOpenMaxAttempts) {
        throw this.createOpenError();
      }
      this.halfOpenInFlight += 1;
    }
  }

  /**
   * Record the outcome of a request started with {@link CircuitBreaker.beforeRequest}.
   */
  afterRequest(success: boolean): void {
    try {
      if (success) {
        this.onSuccess();
      } else {
        this.onFailure();
      }
    } finally {
      if (this.halfOpenInFlight > 0) {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
    }
  }

  /**
   * Run `fn` through the circuit breaker.
   *
   * @throws {@link CircuitOpenError} when the circuit is OPEN and reset timeout has not elapsed.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.beforeRequest();
    let success = false;
    try {
      const result = await fn();
      success = true;
      return result;
    } finally {
      this.afterRequest(success);
    }
  }

  /** Whether the circuit is OPEN and not yet eligible for half-open probes. */
  isOpen(): boolean {
    this.maybeTransitionToHalfOpen();
    return this.state === 'open';
  }

  /**
   * Whether a new request would be rejected (OPEN, or HALF_OPEN at probe capacity).
   */
  wouldRejectRequest(): boolean {
    this.maybeTransitionToHalfOpen();
    if (this.state === 'open') return true;
    if (this.state === 'half_open' && this.halfOpenInFlight >= this.halfOpenMaxAttempts) {
      return true;
    }
    return false;
  }

  /** Milliseconds until the circuit may transition to HALF_OPEN (0 if not open). */
  retryAfterMs(): number {
    if (this.state !== 'open' || this.openedAtMs === undefined) {
      return 0;
    }
    const elapsed = this.now() - this.openedAtMs;
    return Math.max(0, this.resetTimeoutMs - elapsed);
  }

  private onSuccess(): void {
    this.totalSuccesses += 1;
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.openedAtMs = undefined;
    this.halfOpenInFlight = 0;
  }

  private onFailure(): void {
    this.totalFailures += 1;
    this.consecutiveFailures += 1;
    this.lastFailureAt = new Date(this.now());

    if (this.state === 'half_open') {
      this.transitionToOpen();
      return;
    }

    if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.transitionToOpen();
    }
  }

  private transitionToOpen(): void {
    this.state = 'open';
    this.openedAtMs = this.now();
    this.halfOpenInFlight = 0;
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== 'open' || this.openedAtMs === undefined) {
      return;
    }

    if (this.now() - this.openedAtMs >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.halfOpenInFlight = 0;
    }
  }

  private createOpenError(): CircuitOpenError {
    const retryAfterMs = this.retryAfterMs() || this.resetTimeoutMs;
    return new CircuitOpenError(
      `Circuit breaker is open for provider "${this.provider}". Retry after ${retryAfterMs}ms.`,
      this.provider,
      retryAfterMs,
    );
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';

import { TokenAccumulator } from './accumulator.js';
import type { TokenRecord } from './types.js';

/** Internal ALS — not exposed directly; access via the helpers below. */
const tokenAccumulatorStorage = new AsyncLocalStorage<TokenAccumulator>();

/**
 * Run `fn` inside a token accounting context.
 * Called at the start of `Agent.run()` and `Agent.stream()`.
 *
 * @example
 * ```ts
 * const result = await withTokenAccounting(runId, async (acc) => {
 *   return await agentLogic(acc);
 * });
 * ```
 */
export async function withTokenAccounting<T>(
  runId: string,
  fn: (accumulator: TokenAccumulator) => Promise<T>,
): Promise<T> {
  const accumulator = new TokenAccumulator(runId);
  return tokenAccumulatorStorage.run(accumulator, () => fn(accumulator));
}

/**
 * Get the active {@link TokenAccumulator} from ALS.
 * Returns `undefined` outside {@link withTokenAccounting} — callers must no-op, not crash.
 */
export function getTokenAccumulator(): TokenAccumulator | undefined {
  return tokenAccumulatorStorage.getStore();
}

/**
 * Record token usage in the current scope.
 * No-op if no accumulator is active.
 */
export function recordTokens(tokens: TokenRecord): void {
  getTokenAccumulator()?.record(tokens);
}

/**
 * Enter a capability scope in the current accumulator.
 * Returns a cleanup function to exit the scope.
 * Prefer {@link withCapabilityScope} when possible.
 */
export function enterCapabilityScope(capability: string): () => void {
  const acc = getTokenAccumulator();
  if (!acc) {
    return () => {};
  }
  acc.enterScope(capability);
  return () => {
    acc.exitScope();
  };
}

/**
 * Run `fn` inside a named capability scope.
 * Tokens recorded inside `fn` are attributed to that capability.
 */
export async function withCapabilityScope<T>(
  capability: string,
  fn: () => Promise<T>,
): Promise<T> {
  const acc = getTokenAccumulator();
  if (!acc) {
    return fn();
  }
  return acc.withScope(capability, fn);
}

/**
 * Run an async generator inside a token-accounting ALS context (streaming-safe).
 *
 * Like {@link withTokenAccounting}, but re-enters the store on every `gen.next()`
 * so awaits across yields still see the active {@link TokenAccumulator}.
 */
export async function* withTokenAccountingGenerator<T>(
  runId: string,
  factory: (accumulator: TokenAccumulator) => AsyncGenerator<T, void, undefined>,
): AsyncGenerator<T, void, undefined> {
  const accumulator = new TokenAccumulator(runId);
  const gen = tokenAccumulatorStorage.run(accumulator, () => factory(accumulator));
  try {
    while (true) {
      const next = await tokenAccumulatorStorage.run(accumulator, () => gen.next());
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    if (gen.return) {
      await tokenAccumulatorStorage
        .run(accumulator, () => gen.return(undefined))
        .catch(() => undefined);
    }
  }
}

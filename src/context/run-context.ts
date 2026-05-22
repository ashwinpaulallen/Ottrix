import { AsyncLocalStorage } from 'node:async_hooks';

/** Propagation context for a single agent run, workflow, or request. */
export interface RunContext {
  /** Stable identifier for an entire run (agent or workflow). Set by entry points. */
  runId: string;
  /** Step identifier within a run; set by {@link withStep}. */
  stepId?: string;
  /** Name of the agent that owns the current scope. */
  agentName?: string;
  /** Upstream request identifier (HTTP, queue message, etc.). */
  requestId?: string;
  /** Extensible — apps add their own fields via {@link runWith}. */
  readonly [key: string]: unknown;
}

/** Thrown by {@link requireRunContext} / {@link withStep} when no ALS context is active. */
export class ContextNotAvailableError extends Error {
  readonly name = 'ContextNotAvailableError';

  constructor(message = 'RunContext is not available outside an active run') {
    super(message);
  }

  /** Type guard for {@link ContextNotAvailableError}. */
  static isContextNotAvailableError(error: unknown): error is ContextNotAvailableError {
    return error instanceof ContextNotAvailableError;
  }
}

/** Typed extension helpers for {@link RunContext}. */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace RunContext {
  /** Augment {@link RunContext} with app-specific typed fields. */
  export type Augment<T extends Record<string, unknown>> = RunContext & T;

  /**
   * Narrow the current context to an augmented type (no runtime check).
   *
   * @example
   * ```ts
   * type AppContext = RunContext.Augment<{ orgId: string }>;
   * const ctx = RunContext.augment<AppContext>(requireRunContext());
   * ```
   */
  export function augment<T extends Record<string, unknown>>(ctx: RunContext): Augment<T> {
    return ctx as Augment<T>;
  }
}

const runContextStorage = new AsyncLocalStorage<RunContext>();

function mergeContexts(outer: RunContext | undefined, inner: RunContext): RunContext {
  return Object.freeze({ ...outer, ...inner });
}

/**
 * Run `fn` inside an AsyncLocalStorage context with the provided {@link RunContext}.
 * Nested calls merge contexts; inner values win on conflicts.
 *
 * The merged context is frozen — mutate via nested {@link runWith} rather than direct assignment.
 */
export function runWith<T>(ctx: RunContext, fn: () => Promise<T> | T): Promise<T> {
  const merged = mergeContexts(runContextStorage.getStore(), ctx);
  return Promise.resolve(runContextStorage.run(merged, fn));
}

/**
 * Run an async generator factory inside a {@link RunContext} (streaming-safe).
 *
 * Unlike a naive `als.run(store, factory)`, this wraps every `gen.next()` invocation in
 * the ALS context so the generator body and all of its `await` points observe the
 * merged store across yields.
 */
export async function* runGeneratorWith<T>(
  ctx: RunContext,
  factory: () => AsyncGenerator<T, void, undefined>,
): AsyncGenerator<T, void, undefined> {
  const merged = mergeContexts(runContextStorage.getStore(), ctx);
  const gen = runContextStorage.run(merged, factory);
  try {
    while (true) {
      const next = await runContextStorage.run(merged, () => gen.next());
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    if (gen.return) {
      await runContextStorage.run(merged, () => gen.return!()).catch(() => undefined);
    }
  }
}

/** Returns the current {@link RunContext} (frozen), or `undefined` when none is active. */
export function getRunContext(): RunContext | undefined {
  return runContextStorage.getStore();
}

/** Returns the current {@link RunContext} or throws {@link ContextNotAvailableError}. */
export function requireRunContext(): RunContext {
  const ctx = getRunContext();
  if (!ctx) {
    throw new ContextNotAvailableError();
  }
  return ctx;
}

/**
 * Returns a merged context with `stepId` set, intended to be passed to {@link runWith}
 * inside an active run.
 *
 * @throws {ContextNotAvailableError} When called outside an active {@link RunContext}.
 *   Step identity has no meaning without a parent run.
 */
export function withStep(stepId: string): RunContext {
  const existing = runContextStorage.getStore();
  if (!existing) {
    throw new ContextNotAvailableError(
      `withStep("${stepId}") was called outside an active RunContext. ` +
        `Wrap it in runWith({ runId, ... }, ...) first.`,
    );
  }
  return { ...existing, stepId };
}

/**
 * Invoke a tool/step executor, passing the current {@link RunContext} as a second
 * argument only when the executor explicitly declares it (`fn.length >= 2`).
 *
 * This preserves backward compatibility for executors that were written before
 * RunContext existed; ctx-aware executors should opt in by declaring `(input, ctx)`.
 *
 * **Gotcha:** `fn.length` does not count parameters with default values
 * (`(input, ctx = undefined) => …` reports length `1`). Declare ctx without a default
 * to ensure it is wired up. The ALS-based {@link getRunContext} remains the primary
 * API and is always available regardless of the executor's arity.
 */
export function invokeWithRunContext<TInput, TOutput>(
  fn: (input: TInput, ctx?: RunContext) => Promise<TOutput>,
  input: TInput,
): Promise<TOutput> {
  if (fn.length >= 2) {
    return fn(input, getRunContext());
  }
  return fn(input);
}

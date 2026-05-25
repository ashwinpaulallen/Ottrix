import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import {
  getTelemetry,
  PromptInjectionGuardrail,
  runWith,
  type InjectionDetection,
  type RunContext,
} from 'ottrix';

/** Hono context variables used by Ottrix middleware. */
export type OttrixVariables = {
  ottrixBody?: Record<string, unknown>;
  ottrixInjection?: InjectionDetection;
};

/** Hono env shape for typed `c.get()` / `c.set()`. */
export type OttrixEnv = { Variables: OttrixVariables };

/** Options for {@link ottrixContext}. */
export interface OttrixContextOptions {
  orgId?: (c: Context) => string | undefined;
  userId?: (c: Context) => string | undefined;
}

/** Options for {@link ottrixInjection}. */
export interface OttrixInjectionOptions {
  mode?: 'block' | 'flag';
  bodyField?: string;
}

/** Options for {@link ottrixTelemetry}. */
export interface OttrixTelemetryOptions {
  spanName?: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Establishes Ottrix {@link RunContext} for each request via AsyncLocalStorage. */
export function ottrixContext(options?: OttrixContextOptions): MiddlewareHandler {
  return createMiddleware<OttrixEnv>(async (c, next) => {
    const ctx = buildRunContext(c, options);
    return runWith(ctx, () => next());
  });
}

/** Scans mutating JSON bodies for prompt injection. */
export function ottrixInjection(options?: OttrixInjectionOptions): MiddlewareHandler {
  const mode = options?.mode ?? 'block';
  const bodyField = options?.bodyField ?? 'message';
  const guardrail = new PromptInjectionGuardrail({ mode });

  return createMiddleware<OttrixEnv>(async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) {
      return next();
    }

    const body = await readJsonBody(c);
    const message = body[bodyField];
    if (typeof message !== 'string' || message.length === 0) {
      return next();
    }

    const detection = await guardrail.checkInput(message);
    if (!detection.detected) {
      return next();
    }

    if (mode === 'flag') {
      c.set('ottrixInjection', detection);
      return next();
    }

    return c.json({ error: 'Blocked' }, 403);
  });
}

/** Wraps each request in an Ottrix telemetry span. */
export function ottrixTelemetry(_options?: OttrixTelemetryOptions): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const telemetry = getTelemetry();
    const startedAt = Date.now();
    const span = telemetry.startSpan('http.request', {
      'http.method': c.req.method,
      'http.route': c.req.path,
    });

    await next();

    span.setAttribute('http.status_code', c.res.status);
    span.setAttribute('http.duration_ms', Date.now() - startedAt);
    span.setStatus(c.res.status >= 400 ? 'error' : 'ok');
    span.end();
  });
}

function buildRunContext(c: Context, options?: OttrixContextOptions): RunContext {
  const runId = c.req.header('x-request-id') ?? randomUUID();
  const orgId = options?.orgId?.(c) ?? c.req.header('x-org-id');
  const userId = options?.userId?.(c) ?? c.req.header('x-user-id');

  return {
    runId,
    ...(orgId ? { orgId } : {}),
    ...(userId ? { userId } : {}),
  } as RunContext;
}

async function readJsonBody(c: Context<OttrixEnv>): Promise<Record<string, unknown>> {
  const cached = c.var.ottrixBody;
  if (cached) {
    return cached;
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  c.set('ottrixBody', body);
  return body;
}

/** Read JSON body, reusing cache from {@link ottrixInjection} when present. */
export async function readAgentMessageBody(
  c: Context<OttrixEnv>,
  bodyField = 'message',
): Promise<{ message?: string; body: Record<string, unknown> }> {
  const body = await readJsonBody(c);
  const message = body[bodyField];
  return {
    body,
    message: typeof message === 'string' ? message : undefined,
  };
}

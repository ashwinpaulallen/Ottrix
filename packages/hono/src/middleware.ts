import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import {
  buildRunContext,
  extractMessage,
  isStreamInjectionRequest,
  rateLimitClientKey,
  requestCorsHeaders,
  retryAfterHeader,
  scanMessageForInjection,
  validateCorsConfig,
  type ContextExtractors,
  type CorsConfig,
  type RateLimitHook,
} from 'ottrix/http';
import {
  getTelemetry,
  PromptInjectionGuardrail,
  runWith,
  type InjectionDetection,
  type RunContext,
} from 'ottrix';
import { readHeaders, readRequestBody } from './helpers.js';

/** Hono context variables used by Ottrix middleware. */
export type OttrixVariables = {
  ottrixContext?: RunContext;
  ottrixInjection?: InjectionDetection;
};

/** Hono env shape for typed `c.get()` / `c.set()`. */
export type OttrixEnv = { Variables: OttrixVariables };

/** Options for {@link ottrixContext}. */
export type OttrixContextOptions = Partial<ContextExtractors>;

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
    const ctx = buildRunContext(readHeaders(c), options);
    c.set('ottrixContext', ctx);
    return runWith(ctx, () => next());
  });
}

/**
 * Sets CORS headers on every response.
 * `true` keeps the legacy wildcard headers. A {@link CorsConfig} uses an allowlist.
 */
export function corsMiddleware(cors: true | CorsConfig = true): MiddlewareHandler {
  if (cors !== true) {
    validateCorsConfig(cors);
  }

  return createMiddleware(async (c, next) => {
    const origin = c.req.header('origin');
    const headers = requestCorsHeaders(origin, cors);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        c.header(key, value);
      }
    }
    await next();
  });
}

/** Rejects the request with 429 when {@link RateLimitHook} denies the client key. */
export function rateLimitMiddleware(hook: RateLimitHook): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const decision = await hook.check(
      rateLimitClientKey({
        forwardedFor: c.req.header('x-forwarded-for'),
        origin: c.req.header('origin'),
      }),
    );
    if (!decision.allowed) {
      const retryAfter = retryAfterHeader(decision.retryAfterMs);
      if (retryAfter !== undefined) {
        c.header('Retry-After', retryAfter);
      }
      return c.json({ error: 'Too many requests' }, 429);
    }
    await next();
  });
}

/** Scans POST bodies and GET `/stream?message=` for prompt injection. */
export function ottrixInjection(options?: OttrixInjectionOptions): MiddlewareHandler {
  const mode = options?.mode ?? 'block';
  const bodyField = options?.bodyField ?? 'message';
  const guardrail = new PromptInjectionGuardrail({ mode });

  return createMiddleware<OttrixEnv>(async (c, next) => {
    let message: string | undefined;

    if (MUTATING_METHODS.has(c.req.method)) {
      const parsed = extractMessage(await readRequestBody(c), bodyField);
      if (!parsed.ok) {
        return next();
      }
      message = parsed.message;
    } else if (isStreamInjectionRequest(c.req.method, c.req.path)) {
      const parsed = extractMessage({ [bodyField]: c.req.query(bodyField) }, bodyField);
      if (!parsed.ok) {
        return next();
      }
      message = parsed.message;
    } else {
      return next();
    }

    const scan = await scanMessageForInjection(message, { mode, guardrail });
    if (scan.allowed) {
      if (scan.flagged) {
        c.set('ottrixInjection', scan.flagged);
      }
      return next();
    }

    return c.json(scan.body, scan.status as 403);
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

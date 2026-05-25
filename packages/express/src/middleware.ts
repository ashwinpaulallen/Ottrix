import type { Request, RequestHandler } from 'express';
import {
  buildRunContext,
  extractMessage,
  isStreamInjectionRequest,
  scanMessageForInjection,
  type ContextExtractors,
} from 'ottrix/http';
import {
  getTelemetry,
  PromptInjectionGuardrail,
  runWith,
  type InjectionDetection,
} from 'ottrix';
import './types.js';

/** Options for {@link runContextMiddleware}. */
export type RunContextMiddlewareOptions = Partial<ContextExtractors>;

/** Options for {@link telemetryMiddleware}. */
export interface TelemetryMiddlewareOptions {
  spanName?: string;
}

/** Options for {@link injectionMiddleware}. */
export interface InjectionMiddlewareOptions {
  mode?: 'block' | 'flag';
  bodyField?: string;
  guardrail?: PromptInjectionGuardrail;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Establishes Ottrix {@link RunContext} for each request via AsyncLocalStorage. */
export function runContextMiddleware(options?: RunContextMiddlewareOptions): RequestHandler {
  return (req, _res, next) => {
    const ctx = buildRunContext(readHeaders(req), options);
    req.ottrixRunContext = ctx;
    void runWith(ctx, () => next()).catch(next);
  };
}

/** Wraps each request in an Ottrix telemetry span. */
export function telemetryMiddleware(options?: TelemetryMiddlewareOptions): RequestHandler {
  const spanName = options?.spanName ?? 'http.request';

  return (req, res, next) => {
    const telemetry = getTelemetry();
    const startedAt = Date.now();
    const span = telemetry.startSpan(spanName, {
      'http.method': req.method,
      'http.route': req.route?.path ?? req.path ?? req.url ?? '/',
    });

    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.setAttribute('http.duration_ms', Date.now() - startedAt);
      span.setStatus(res.statusCode >= 400 ? 'error' : 'ok');
      span.end();
    });

    next();
  };
}

/** Scans POST bodies and GET `/stream?message=` for prompt injection. */
export function injectionMiddleware(options?: InjectionMiddlewareOptions): RequestHandler {
  const mode = options?.mode ?? 'block';
  const bodyField = options?.bodyField ?? 'message';
  const guardrail = options?.guardrail ?? new PromptInjectionGuardrail({ mode });

  return async (req, res, next) => {
    let message: string | undefined;

    if (MUTATING_METHODS.has(req.method)) {
      const parsed = extractMessage(req.body, bodyField);
      if (!parsed.ok) {
        next();
        return;
      }
      message = parsed.message;
    } else if (isStreamInjectionRequest(req.method, req.path)) {
      const parsed = extractMessage({ message: req.query?.message }, bodyField);
      if (!parsed.ok) {
        next();
        return;
      }
      message = parsed.message;
    } else {
      next();
      return;
    }

    try {
      const scan = await scanMessageForInjection(message, { mode, guardrail });
      if (scan.allowed) {
        if (scan.flagged) {
          req.ottrixInjection = scan.flagged;
        }
        next();
        return;
      }

      res.status(scan.status).json(scan.body);
    } catch (error) {
      next(error);
    }
  };
}

function readHeaders(req: Request): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value[0];
    } else if (value !== undefined) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

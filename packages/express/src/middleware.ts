import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import {
  BudgetGuardrail,
  getConfiguredBudgets,
  getTelemetry,
  PromptInjectionGuardrail,
  runWith,
  type RunContext,
} from 'ottrix';
import './types.js';

/** Options for {@link runContextMiddleware}. */
export interface RunContextMiddlewareOptions {
  orgId?: (req: Request) => string | undefined;
  userId?: (req: Request) => string | undefined;
}

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

/** Options for {@link budgetMiddleware}. */
export interface BudgetMiddlewareOptions {
  guardrail?: BudgetGuardrail;
  config?: ConstructorParameters<typeof BudgetGuardrail>[0];
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Establishes Ottrix {@link RunContext} for each request via AsyncLocalStorage. */
export function runContextMiddleware(options?: RunContextMiddlewareOptions): RequestHandler {
  return (req, res, next) => {
    const runContext = buildRunContext(req, options);
    req.ottrixRunContext = runContext;

    runWith(runContext, () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        res.once('finish', finish);
        res.once('close', finish);

        try {
          next();
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          throw error;
        }
      }),
    ).catch((error) => {
      if (!res.headersSent) {
        next(error);
      }
    });
  };
}

/** Wraps each request in an Ottrix telemetry span. */
export function telemetryMiddleware(_options?: TelemetryMiddlewareOptions): RequestHandler {
  return (req, res, next) => {
    const telemetry = getTelemetry();
    const startedAt = Date.now();
    const span = telemetry.startSpan('http.request', {
      'http.method': req.method,
      'http.route': req.route?.path ?? req.path ?? req.url ?? '/',
    });

    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.setAttribute('http.duration_ms', Date.now() - startedAt);
      span.setStatus(res.statusCode >= 400 ? 'error' : 'ok');
      span.end();
    });

    try {
      next();
    } catch (error) {
      span.setStatus('error', error instanceof Error ? error.message : String(error));
      span.end();
      throw error;
    }
  };
}

/** Scans mutating request bodies for prompt injection via {@link PromptInjectionGuardrail}. */
export function injectionMiddleware(options?: InjectionMiddlewareOptions): RequestHandler {
  const mode = options?.mode ?? 'block';
  const bodyField = options?.bodyField ?? 'message';
  const guardrail = options?.guardrail ?? new PromptInjectionGuardrail({ mode });

  return async (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const message = req.body?.[bodyField];
    if (typeof message !== 'string' || message.length === 0) {
      next();
      return;
    }

    try {
      const detection = await guardrail.checkInput(message);
      if (!detection.detected) {
        next();
        return;
      }

      if (mode === 'flag') {
        req.ottrixInjection = detection;
        next();
        return;
      }

      res.status(403).json({ error: 'Blocked' });
    } catch (error) {
      next(error);
    }
  };
}

/** Blocks requests when Ottrix budget guardrails are already exceeded. */
export function budgetMiddleware(options: BudgetMiddlewareOptions = {}): RequestHandler {
  const guardrail =
    options.guardrail ?? new BudgetGuardrail(options.config ?? getConfiguredBudgets() ?? {});

  return async (req, res, next) => {
    try {
      const decision = await guardrail.beforeTool({
        phase: 'tool',
        timing: 'pre',
        agentName: req.ottrixRunContext?.agentName?.toString() ?? 'http',
        toolName: 'request',
        input: {},
      });

      if (decision?.action === 'block') {
        res.status(429).json({ error: 'Budget exceeded' });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function buildRunContext(req: Request, options?: RunContextMiddlewareOptions): RunContext {
  const headers = req.headers;
  const runId = readHeader(headers, 'x-request-id') ?? randomUUID();

  const orgId = options?.orgId?.(req) ?? readHeader(headers, 'x-org-id');
  const userId = options?.userId?.(req) ?? readHeader(headers, 'x-user-id');

  return {
    runId,
    ...(orgId ? { orgId } : {}),
    ...(userId ? { userId } : {}),
  } as RunContext;
}

function readHeader(headers: Request['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

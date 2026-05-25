import {
  Router,
  type NextFunction,
  type Request,
  type Response,
  type Router as ExpressRouter,
} from 'express';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import {
  agentEventToSse,
  checkHealth,
  corsHeaders,
  extractMessage,
  formatSseComment,
  formatSseEvent,
  KEEPALIVE_INTERVAL_MS,
  SSE_HEADERS,
  type ContextExtractors,
} from 'ottrix/http';
import { runWith } from 'ottrix';
import { ottrixErrorHandler } from './errors.js';
import { injectionMiddleware, runContextMiddleware } from './middleware.js';

/** Options for {@link createAgentRouter}. */
export interface AgentRouterOptions {
  agent: Agent;
  /** POST route path on this router. @defaultValue `'/'` */
  path?: string;
  /** Register `GET /stream` SSE endpoint. @defaultValue `true` */
  streaming?: boolean;
  /** JSON body field for the user message on `POST`. @defaultValue `'message'` */
  bodyField?: string;
  /** Prompt injection handling. @defaultValue `'block'` */
  injection?: 'block' | 'flag' | false;
  /** Enable CORS headers and `OPTIONS` handler. @defaultValue `true` */
  cors?: boolean;
  /** Register `GET /health` endpoint. @defaultValue `true` */
  healthCheck?: boolean;
  /** Provider registry for health checks. */
  registry?: ProviderRegistry;
  /** Enable RunContext middleware. @defaultValue `true` */
  runContext?: boolean | Partial<ContextExtractors>;
}

/** Creates an Express router with agent, streaming, health, CORS, and error handling. */
export function createAgentRouter(options: AgentRouterOptions): ExpressRouter {
  const {
    agent,
    path = '/',
    streaming = true,
    bodyField = 'message',
    injection = 'block',
    cors = true,
    healthCheck = true,
    registry,
    runContext = true,
  } = options;

  const router = Router();

  if (runContext !== false) {
    const extractors = runContext === true ? undefined : runContext;
    router.use(runContextMiddleware(extractors));
  }

  if (cors) {
    router.use((req, res, next) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      for (const [key, value] of Object.entries(corsHeaders(origin))) {
        res.setHeader(key, value as string);
      }
      next();
    });
  }

  if (injection !== false) {
    router.use(injectionMiddleware({ mode: injection, bodyField }));
  }

  router.post(path, async (req: Request, res: Response, next: NextFunction) => {
    const execute = async () => {
      const parsed = extractMessage(readRequestBody(req), bodyField);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error });
        return;
      }

      const result = await agent.run(parsed.message);
      res.json(result);
    };

    try {
      if (req.ottrixRunContext) {
        await runWith(req.ottrixRunContext, execute);
      } else {
        await execute();
      }
    } catch (error) {
      next(error);
    }
  });

  if (streaming) {
    router.get('/stream', async (req: Request, res: Response, next: NextFunction) => {
      const parsed = extractMessage({ message: req.query.message }, 'message');
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error });
        return;
      }

      for (const [key, value] of Object.entries(SSE_HEADERS)) {
        res.setHeader(key, value as string);
      }
      res.flushHeaders?.();

      let closed = false;
      const onClose = () => {
        closed = true;
      };
      req.on('close', onClose);
      res.on('close', onClose);

      const firstKeepaliveMs = Math.min(100, KEEPALIVE_INTERVAL_MS);
      const firstKeepaliveTimer = setTimeout(() => {
        if (!closed) {
          res.write(formatSseComment('keepalive'));
        }
      }, firstKeepaliveMs);
      firstKeepaliveTimer.unref?.();

      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          res.write(formatSseComment('keepalive'));
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer.unref?.();

      try {
        let index = 0;
        for await (const event of agent.stream(parsed.message)) {
          if (closed) {
            break;
          }
          res.write(formatSseEvent(agentEventToSse(event, index)));
          index += 1;
          if (event.type === 'done') {
            break;
          }
        }
      } catch (error) {
        clearTimeout(firstKeepaliveTimer);
        clearInterval(keepaliveTimer);
        req.off('close', onClose);
        res.off('close', onClose);
        if (!closed) {
          next(error);
        }
        return;
      }

      clearTimeout(firstKeepaliveTimer);
      clearInterval(keepaliveTimer);
      req.off('close', onClose);
      res.off('close', onClose);
      if (!closed) {
        res.end();
      }
    });
  }

  if (healthCheck) {
    router.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
      if (!registry) {
        res.status(503).json({
          error: 'Provider registry is required for health checks',
          code: 'missing_registry',
        });
        return;
      }

      try {
        const result = await checkHealth(registry);
        res.json(result);
      } catch (error) {
        next(error);
      }
    });
  }

  if (cors) {
    router.options(path, (_req: Request, res: Response) => {
      res.status(204).end();
    });
  }

  router.use(ottrixErrorHandler());

  return router;
}

function readRequestBody(req: Request): unknown {
  if (req.body === undefined || req.body === null) {
    return undefined;
  }

  if (typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length === 0) {
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      return undefined;
    }
  }

  return req.body;
}


import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Agent } from 'ottrix';
import { sendAgentStream } from './sse.js';

/** Options for {@link createAgentRouter}. */
export interface AgentRouterOptions {
  agent: Agent;
  /** Mount path prefix used when registering routes on the router. @defaultValue `'/'` */
  path?: string;
  /** Register `GET /stream` SSE endpoint. @defaultValue `true` */
  streaming?: boolean;
  /** JSON body field for the user message on `POST`. @defaultValue `'message'` */
  bodyField?: string;
}

/** Creates an Express router with `POST /` and optional `GET /stream` agent endpoints. */
export function createAgentRouter(options: AgentRouterOptions): Router {
  const { agent, streaming = true, bodyField = 'message' } = options;
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const message = req.body?.[bodyField];
    if (typeof message !== 'string' || message.length === 0) {
      res.status(400).json({ error: `${bodyField} required` });
      return;
    }

    try {
      const result = await agent.run(message);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  if (streaming) {
    router.get('/stream', (req: Request, res: Response, next: NextFunction) => {
      const message = req.query.message;
      if (typeof message !== 'string' || message.length === 0) {
        res.status(400).json({ error: 'message query parameter required' });
        return;
      }

      try {
        sendAgentStream(agent, message, res, req);
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}

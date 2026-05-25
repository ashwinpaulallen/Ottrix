import { Hono } from 'hono';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import { ottrixErrorHandler } from './errors.js';
import { agentHandler, agentStreamHandler, ottrixHealth } from './handlers.js';
import {
  corsMiddleware,
  ottrixContext,
  ottrixInjection,
  type OttrixEnv,
} from './middleware.js';

/** Options for {@link ottrix}. */
export interface OttrixOptions {
  agent: Agent;
  /** POST route path on this sub-app. @defaultValue `'/'` */
  path?: string;
  /** JSON body field for the user message on `POST`. @defaultValue `'message'` */
  bodyField?: string;
  /** Prompt injection handling. @defaultValue `'block'` */
  injection?: 'block' | 'flag' | false;
  /** Enable CORS headers and `OPTIONS` handler. @defaultValue `true` */
  cors?: boolean;
  /** Register `GET /health` endpoint. @defaultValue `true` */
  healthCheck?: boolean;
  /** Register `GET /stream` SSE endpoint. @defaultValue `true` */
  streaming?: boolean;
  /** Enable RunContext middleware. @defaultValue `true` */
  runContext?: boolean;
  /** Provider registry for health checks. */
  registry?: ProviderRegistry;
}

/** Creates a pre-configured Hono sub-app with agent routes and middleware. */
export function ottrix(options: OttrixOptions): Hono<OttrixEnv> {
  const {
    agent,
    path = '/',
    bodyField = 'message',
    injection = 'block',
    cors = true,
    healthCheck = true,
    streaming = true,
    runContext = true,
    registry,
  } = options;

  const sub = new Hono<OttrixEnv>();

  if (runContext !== false) {
    sub.use('*', ottrixContext());
  }

  if (injection !== false) {
    sub.use('*', ottrixInjection({ mode: injection, bodyField }));
  }

  if (cors !== false) {
    sub.use('*', corsMiddleware());
  }

  sub.post(path, agentHandler(agent, { bodyField }));

  if (streaming !== false) {
    sub.get('/stream', agentStreamHandler(agent));
  }

  if (healthCheck !== false) {
    sub.get('/health', ottrixHealth({ registry }));
  }

  if (cors !== false) {
    sub.options(path, (c) => c.body(null, 204));
  }

  sub.onError(ottrixErrorHandler());

  return sub;
}

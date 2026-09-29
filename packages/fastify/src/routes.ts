import type { FastifyPluginAsync } from 'fastify';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import { runWith } from 'ottrix';
import {
  agentEventToSse,
  checkHealth,
  extractMessage,
  formatSseComment,
  formatSseEvent,
  KEEPALIVE_INTERVAL_MS,
  rateLimitClientKey,
  requestCorsHeaders,
  retryAfterHeader,
  SSE_HEADERS,
  validateCorsConfig,
  type CorsConfig,
  type RateLimitHook,
} from 'ottrix/http';
import { readRequestBody } from './helpers.js';

/** Options for {@link agentRoutes}. */
export interface AgentRoutesOptions {
  agent: Agent;
  /** POST route path on this plugin. @defaultValue `'/'` */
  path?: string;
  /** Register `GET /stream` SSE endpoint. @defaultValue `true` */
  streaming?: boolean;
  /** JSON body field for the user message on `POST`. @defaultValue `'message'` */
  bodyField?: string;
  /**
   * CORS policy. `true` keeps the legacy wildcard headers.
   * A {@link CorsConfig} uses an explicit allowlist. @defaultValue `true`
   */
  cors?: boolean | CorsConfig;
  /** Optional application-owned rate limit check. Denied requests receive 429. */
  rateLimitHook?: RateLimitHook;
  /** Register `GET /health` endpoint. @defaultValue `true` */
  healthCheck?: boolean;
  /** Provider registry for health checks. Defaults to `fastify.ottrix.providers`. */
  registry?: ProviderRegistry;
}

/** Registers agent POST, SSE stream, health, and CORS routes. */
export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (fastify, options) => {
  const {
    agent,
    path = '/',
    streaming = true,
    bodyField = 'message',
    cors = true,
    healthCheck = true,
    registry = fastify.ottrix?.providers,
    rateLimitHook,
  } = options;

  if (cors !== false && cors !== true) {
    validateCorsConfig(cors);
  }

  if (rateLimitHook || cors !== false) {
    const corsOption = cors;
    fastify.addHook('onRequest', async (request, reply) => {
        const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
        if (corsOption !== false) {
          const headers = requestCorsHeaders(origin, corsOption === true ? true : corsOption);
          if (headers) {
            for (const [key, value] of Object.entries(headers)) {
              reply.header(key, value);
            }
          }
        }

        if (rateLimitHook) {
          const decision = await rateLimitHook.check(
            rateLimitClientKey({
              forwardedFor: request.headers['x-forwarded-for'],
              remoteAddress: request.ip,
              origin,
            }),
          );
          if (!decision.allowed) {
            const retryAfter = retryAfterHeader(decision.retryAfterMs);
            if (retryAfter !== undefined) {
              reply.header('Retry-After', retryAfter);
            }
            await reply.code(429).send({ error: 'Too many requests' });
            return;
          }
        }
    });
  }

  fastify.post(path, async (request, reply) => {
    const execute = async () => {
      const parsed = extractMessage(readRequestBody(request), bodyField);
      if (!parsed.ok) {
        reply.code(parsed.status).send({ error: parsed.error });
        return;
      }

      const result = await agent.run(parsed.message);
      reply.send(result);
    };

    if (request.ottrixContext) {
      await runWith(request.ottrixContext, execute);
    } else {
      await execute();
    }
  });

  if (streaming) {
    fastify.get('/stream', async (request, reply) => {
      const parsed = extractMessage({ message: (request.query as { message?: unknown }).message }, 'message');
      if (!parsed.ok) {
        reply.code(parsed.status).send({ error: parsed.error });
        return;
      }

      reply.raw.writeHead(200, SSE_HEADERS as Record<string, string | number>);
      reply.hijack();

      let closed = false;
      const onClose = () => {
        closed = true;
      };
      request.raw.on('close', onClose);

      const firstKeepaliveMs = Math.min(100, KEEPALIVE_INTERVAL_MS);
      const firstKeepaliveTimer = setTimeout(() => {
        if (!closed) {
          reply.raw.write(formatSseComment('keepalive'));
        }
      }, firstKeepaliveMs);
      firstKeepaliveTimer.unref?.();

      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          reply.raw.write(formatSseComment('keepalive'));
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer.unref?.();

      try {
        let index = 0;
        for await (const event of agent.stream(parsed.message)) {
          if (closed) {
            break;
          }
          reply.raw.write(formatSseEvent(agentEventToSse(event, index)));
          index += 1;
          if (event.type === 'done') {
            break;
          }
        }
      } catch (error) {
        clearTimeout(firstKeepaliveTimer);
        clearInterval(keepaliveTimer);
        request.raw.off('close', onClose);
        if (!closed) {
          throw error;
        }
        return;
      }

      clearTimeout(firstKeepaliveTimer);
      clearInterval(keepaliveTimer);
      request.raw.off('close', onClose);
      if (!closed) {
        reply.raw.end();
      }
    });
  }

  if (healthCheck) {
    fastify.get('/health', async (_request, reply) => {
      if (!registry) {
        reply.code(503).send({
          error: 'Provider registry is required for health checks',
          code: 'missing_registry',
        });
        return;
      }

      const result = await checkHealth(registry);
      reply.send(result);
    });
  }

  if (cors) {
    fastify.options(path, async (_request, reply) => {
      reply.code(204).send();
    });
  }
};

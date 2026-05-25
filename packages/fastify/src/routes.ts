import type { FastifyPluginAsync } from 'fastify';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import { runWith } from 'ottrix';
import {
  agentEventToSse,
  checkHealth,
  corsHeaders,
  extractMessage,
  formatSseComment,
  formatSseEvent,
  KEEPALIVE_INTERVAL_MS,
  SSE_HEADERS,
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
  /** Enable CORS headers and `OPTIONS` handler. @defaultValue `true` */
  cors?: boolean;
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
  } = options;

  if (cors) {
    fastify.addHook('onRequest', (request, reply, done) => {
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      for (const [key, value] of Object.entries(corsHeaders(origin))) {
        reply.header(key, value as string);
      }
      done();
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

    try {
      if (request.ottrixContext) {
        await runWith(request.ottrixContext, execute);
      } else {
        await execute();
      }
    } catch (error) {
      throw error;
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

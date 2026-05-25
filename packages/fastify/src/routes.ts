import type { FastifyPluginAsync } from 'fastify';
import type { Agent, AgentEvent } from 'ottrix';

const KEEPALIVE_MS = 15_000;

/** Options for {@link agentRoutes}. */
export interface AgentRoutesOptions {
  agent: Agent;
  prefix?: string;
}

const chatBodySchema = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string', minLength: 1 },
  },
} as const;

const streamQuerySchema = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string', minLength: 1 },
  },
} as const;

/** Registers `POST /` and `GET /stream` agent routes (use Fastify `prefix` when registering). */
export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (fastify, options) => {
  const { agent } = options;

  fastify.post(
    '/',
    {
      schema: {
        body: chatBodySchema,
      },
    },
    async (request) => {
      const { message } = request.body as { message: string };
      return agent.run(message);
    },
  );

  fastify.get(
    '/stream',
    {
      schema: {
        querystring: streamQuerySchema,
      },
    },
    async (request, reply) => {
      const { message } = request.query as { message: string };

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.hijack();

      let closed = false;
      const onClose = () => {
        closed = true;
      };
      request.raw.on('close', onClose);

      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          reply.raw.write(': keepalive\n\n');
        }
      }, KEEPALIVE_MS);
      keepaliveTimer.unref?.();

      try {
        for await (const event of agent.stream(message)) {
          if (closed) {
            break;
          }
          writeSseEvent(reply.raw, event);
          if (event.type === 'done') {
            break;
          }
        }
      } finally {
        clearInterval(keepaliveTimer);
        request.raw.off('close', onClose);
        if (!closed) {
          reply.raw.end();
        }
      }
    },
  );
};

function writeSseEvent(
  stream: NodeJS.WritableStream,
  event: AgentEvent,
): void {
  stream.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

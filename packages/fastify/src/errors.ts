import type { FastifyInstance } from 'fastify';
import { mapOttrixError } from 'ottrix/http';

export { mapOttrixError } from 'ottrix/http';

/** Register Ottrix-aware error handling on a Fastify instance. */
export function registerOttrixErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, _request, reply) => {
    if (reply.sent) {
      throw error;
    }

    const { status, body, headers } = mapOttrixError(error);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        reply.header(key, value);
      }
    }
    reply.code(status).send(body);
  });
}

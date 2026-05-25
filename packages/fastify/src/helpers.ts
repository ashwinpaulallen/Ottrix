import type { FastifyRequest } from 'fastify';

/** Normalize Fastify request headers for {@link buildRunContext}. */
export function readHeaders(request: FastifyRequest): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value[0];
    } else if (value !== undefined) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

/** Treat empty unparsed bodies as missing for {@link extractMessage}. */
export function readRequestBody(request: FastifyRequest): unknown {
  const body = request.body;
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    const contentType = request.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      return undefined;
    }
  }

  return body;
}

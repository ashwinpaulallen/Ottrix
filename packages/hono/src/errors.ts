import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { mapOttrixError } from 'ottrix/http';

export { mapOttrixError } from 'ottrix/http';

/** Hono error handler that maps Ottrix errors to HTTP status codes. */
export function ottrixErrorHandler(): ErrorHandler {
  return (error, c) => {
    const { status, body, headers } = mapOttrixError(error);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        c.header(key, value);
      }
    }
    return c.json(body, status as ContentfulStatusCode);
  };
}

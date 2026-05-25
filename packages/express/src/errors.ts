import type { ErrorRequestHandler } from 'express';
import { mapOttrixError } from 'ottrix/http';

/** Maps Ottrix errors to sanitized HTTP responses via {@link mapOttrixError}. */
export function ottrixErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (res.headersSent) {
      return;
    }

    const { status, body, headers } = mapOttrixError(err);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }
    }
    res.status(status).json(body);
  };
}

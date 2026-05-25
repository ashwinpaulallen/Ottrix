import type { Context } from 'hono';

/** Normalize Hono request headers for {@link buildRunContext}. */
export function readHeaders(c: Context): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(c.req.header())) {
    if (value !== undefined) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

/** Safely read a JSON body for {@link extractMessage}. */
export async function readRequestBody(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type');

  if (!contentType?.includes('application/json')) {
    const contentLength = c.req.header('content-length');
    if (!contentType && (contentLength === undefined || contentLength === '0')) {
      return undefined;
    }
  }

  try {
    const body = await c.req.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body as Record<string, unknown>).length === 0 &&
      !contentType?.includes('application/json')
    ) {
      return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

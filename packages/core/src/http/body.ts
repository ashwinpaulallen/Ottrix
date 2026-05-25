/** Safely extract a message string from a JSON request body. */
export function extractMessage(
  body: unknown,
  fieldName = 'message',
): { ok: true; message: string } | { ok: false; error: string; status: number } {
  if (body === null || body === undefined) {
    return { ok: false, error: 'Request body is empty', status: 400 };
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be JSON', status: 400 };
  }

  const record = body as Record<string, unknown>;
  if (!(fieldName in record)) {
    return {
      ok: false,
      error: `Missing '${fieldName}' field in request body`,
      status: 400,
    };
  }

  const value = record[fieldName];
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `Field '${fieldName}' must be a string`,
      status: 400,
    };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `Field '${fieldName}' must not be empty`,
      status: 400,
    };
  }

  return { ok: true, message: trimmed };
}

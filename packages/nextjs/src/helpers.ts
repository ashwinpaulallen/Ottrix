/** Normalize Web API request headers for {@link buildRunContext}. */
export function readRequestHeaders(request: Request): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/** Safely read a JSON body for {@link extractMessage}. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? undefined;
  const contentLength = request.headers.get('content-length') ?? undefined;

  if (!contentType?.includes('application/json')) {
    if (!contentType && (contentLength === undefined || contentLength === '0')) {
      return undefined;
    }
  }

  try {
    const body: unknown = await request.json();
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

/**
 * Whether AsyncLocalStorage-backed {@link runWith} is available.
 * RunContext is skipped on Next.js Edge runtime.
 */
export function isRunContextSupported(): boolean {
  if (typeof process !== 'undefined' && process.env?.NEXT_RUNTIME === 'edge') {
    return false;
  }
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

/** Merge response header objects. */
export function mergeHeaders(...groups: Array<Record<string, string>>): Record<string, string> {
  return Object.assign({}, ...groups);
}

/** JSON {@link Response} helper. */
export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: mergeHeaders({ 'Content-Type': 'application/json' }, extraHeaders),
  });
}

/** Extract the last user message from a Vercel AI SDK `{ messages: [...] }` body. */
export function extractLastUserMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') {
      continue;
    }

    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user') {
      continue;
    }

    if (typeof record.content === 'string') {
      const trimmed = record.content.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    if (Array.isArray(record.content)) {
      const text = record.content
        .filter(
          (part): part is { type: string; text: string } =>
            !!part &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string',
        )
        .map((part) => part.text)
        .join('');
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }

  return undefined;
}

import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import type { SseEvent } from 'ottrix/http';
import {
  createAgentHandlers,
  createHealthHandler,
  createPostHandler,
  createStreamHandler,
} from '../src/index.js';

export function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = [];

  for (const block of body.split('\n\n')) {
    if (!block.trim()) {
      continue;
    }

    if (block.startsWith(':')) {
      events.push({ event: 'comment', data: block.slice(1).trim() });
      continue;
    }

    let eventName = 'message';
    let data = '';
    let id: string | undefined;

    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      }
    }

    events.push({ event: eventName, data, ...(id ? { id } : {}) });
  }

  return events;
}

export function parseJsonBody(body: string): unknown {
  if (!body) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export interface NextHandlerAppOptions {
  agent: Agent;
  streaming?: boolean;
  injection?: 'block' | 'flag' | false;
  bodyField?: string;
  cors?: boolean;
  healthCheck?: boolean;
  registry?: ProviderRegistry;
}

export function createNextHandlerApp(options: NextHandlerAppOptions) {
  const handlerOptions = {
    agent: options.agent,
    bodyField: options.bodyField,
    injection: options.injection ?? false,
    cors: options.cors ?? false,
    runContext: true,
  };

  const post = createPostHandler(handlerOptions);
  const stream = createStreamHandler(handlerOptions);
  const health = createHealthHandler({ registry: options.registry });
  const combined = createAgentHandlers(handlerOptions);

  return { post, stream, health, combined };
}

export async function invokeHandler(
  handler: (request: Request) => Response | Promise<Response>,
  method: string,
  path: string,
  init?: {
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );

  return {
    status: response.status,
    body: parseJsonBody(await response.text()),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

export async function invokeSseHandler(
  handler: (request: Request) => Response | Promise<Response>,
  path: string,
  query?: Record<string, string>,
): Promise<{ status: number; events: SseEvent[]; headers: Record<string, string> }> {
  const url = query ? `${path}?${new URLSearchParams(query).toString()}` : path;
  const response = await handler(new Request(`http://localhost${url}`, { method: 'GET' }));

  if (response.status >= 400) {
    return {
      status: response.status,
      events: [],
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  return {
    status: response.status,
    events: parseSseEvents(await response.text()),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

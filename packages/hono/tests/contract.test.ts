import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { SseEvent } from 'ottrix/http';
import {
  createMockAgent,
  createMockProviderRegistry,
} from 'ottrix/testing';
import { runAdapterContractTests } from 'ottrix/testing/contract';
import { ottrix } from '../src/index.js';

function parseSseEvents(body: string): SseEvent[] {
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

function parseJsonBody(body: string): unknown {
  if (!body) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

runAdapterContractTests({
  createApp: async (options) => {
    const agent = options.agent ?? createMockAgent();
    const app = new Hono();

    app.route(
      '/',
      ottrix({
        agent,
        path: '/chat',
        injection: options.injection ?? false,
        cors: options.cors ?? false,
        healthCheck: options.healthCheck ?? false,
        streaming: options.streaming ?? true,
        registry: options.registry,
        bodyField: options.bodyField,
        runContext: true,
      }),
    );

    return {
      request: async (method, path, opts) => {
        const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
        if (opts?.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }

        const response = await app.request(path, {
          method,
          headers,
          body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });

        return {
          status: response.status,
          body: parseJsonBody(await response.text()),
          headers: Object.fromEntries(response.headers.entries()),
        };
      },
      requestSse: async (path, query) => {
        const url = query
          ? `${path}?${new URLSearchParams(query).toString()}`
          : path;
        const response = await app.request(url, { method: 'GET' });

        if (response.status >= 400) {
          return { status: response.status, events: [] };
        }

        return {
          status: response.status,
          events: parseSseEvents(await response.text()),
        };
      },
      close: async () => undefined,
    };
  },
});

describe('@ottrix/hono contract harness', () => {
  it('loads the contract suite', () => {
    expect(runAdapterContractTests).toBeTypeOf('function');
  });

  it('builds a mock registry for health checks', async () => {
    const registry = createMockProviderRegistry({ providers: { primary: 'healthy' } });
    expect(registry.listRegisteredProviders()).toContain('primary');
  });
});

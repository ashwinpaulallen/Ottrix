import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SseEvent } from 'ottrix/http';
import {
  createMockAgent,
  createMockProviderRegistry,
} from 'ottrix/testing';
import { runAdapterContractTests } from 'ottrix/testing/contract';
import { agentRoutes, ottrixPlugin } from '../src/index.js';

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
    const app = Fastify();

    await app.register(ottrixPlugin, {
      injection: options.injection ?? false,
      runContext: true,
      telemetry: false,
    });

    await app.register(agentRoutes, {
      agent,
      path: '/chat',
      cors: options.cors ?? false,
      healthCheck: options.healthCheck ?? false,
      streaming: options.streaming ?? true,
      registry: options.registry,
      bodyField: options.bodyField,
    });

    return {
      request: async (method, path, opts) => {
        const response = await app.inject({
          method: method as 'GET' | 'POST' | 'OPTIONS',
          url: path,
          headers: opts?.headers,
          payload: opts?.body as object | string | undefined,
        });

        return {
          status: response.statusCode,
          body: parseJsonBody(response.body),
          headers: response.headers as Record<string, string>,
        };
      },
      requestSse: async (path, query) => {
        const url = query
          ? `${path}?${new URLSearchParams(query).toString()}`
          : path;
        const response = await app.inject({ method: 'GET', url });

        if (response.statusCode >= 400) {
          return { status: response.statusCode, events: [] };
        }

        return {
          status: response.statusCode,
          events: parseSseEvents(response.body),
        };
      },
      close: async () => {
        await app.close();
      },
    };
  },
});

describe('@ottrix/fastify contract harness', () => {
  it('loads the contract suite', () => {
    expect(runAdapterContractTests).toBeTypeOf('function');
  });

  it('builds a mock registry for health checks', async () => {
    const registry = createMockProviderRegistry({ providers: { primary: 'healthy' } });
    expect(registry.listRegisteredProviders()).toContain('primary');
  });
});

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { SseEvent } from 'ottrix/http';
import {
  createMockAgent,
  createMockProviderRegistry,
  runAdapterContractTests,
} from 'ottrix/testing';
import { createAgentRouter, ottrixErrorHandler } from '../src/index.js';

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

runAdapterContractTests({
  createApp: async (options) => {
    const agent = options.agent ?? createMockAgent();
    const app = express();
    app.use(express.json());
    app.use(
      createAgentRouter({
        agent,
        path: '/chat',
        injection: options.injection ?? false,
        cors: options.cors ?? false,
        healthCheck: options.healthCheck ?? false,
        bodyField: options.bodyField,
        streaming: options.streaming ?? true,
        registry: options.registry,
        runContext: true,
      }),
    );
    app.use(ottrixErrorHandler());

    return {
      request: async (method, path, opts) => {
        const verb = method.toLowerCase() as 'get' | 'post' | 'options';
        let req = request(app)[verb](path);
        if (opts?.headers) {
          for (const [key, value] of Object.entries(opts.headers)) {
            req = req.set(key, value);
          }
        }
        if (opts?.body) {
          req = req.send(opts.body);
        }
        const res = await req;
        return { status: res.status, body: res.body, headers: res.headers as Record<string, string> };
      },
      requestSse: async (path, query) => {
        let req = request(app).get(path);
        if (query) {
          req = req.query(query);
        }
        const res = await req;
        if (res.status >= 400) {
          return { status: res.status, events: [] };
        }
        return { status: res.status, events: parseSseEvents(res.text) };
      },
    close: async () => undefined,
  };
},
});

describe('@ottrix/express contract harness', () => {
  it('loads the contract suite', () => {
    expect(runAdapterContractTests).toBeTypeOf('function');
  });

  it('builds a mock registry for health checks', async () => {
    const registry = createMockProviderRegistry({ providers: { primary: 'healthy' } });
    expect(registry.listRegisteredProviders()).toContain('primary');
  });
});

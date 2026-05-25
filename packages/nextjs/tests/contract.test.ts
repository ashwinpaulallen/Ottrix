import { describe, expect, it } from 'vitest';
import type { SseEvent } from 'ottrix/http';
import {
  createMockAgent,
  createMockProviderRegistry,
} from 'ottrix/testing';
import { runAdapterContractTests } from 'ottrix/testing/contract';
import {
  createHealthHandler,
  createPostHandler,
  createStreamHandler,
  createAgentHandlers,
} from '../src/index.js';
import { parseJsonBody, parseSseEvents } from './helpers.js';

runAdapterContractTests({
  createApp: async (options) => {
    const agent = options.agent ?? createMockAgent();
    const handlerOptions = {
      agent,
      bodyField: options.bodyField,
      injection: options.injection ?? false,
      cors: options.cors ?? false,
      runContext: true,
    };

    const post = createPostHandler(handlerOptions);
    const stream = createStreamHandler(handlerOptions);
    const health = createHealthHandler({ registry: options.registry });
    const combined = createAgentHandlers(handlerOptions);

    return {
      request: async (method, path, opts) => {
        const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
        if (opts?.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }

        let handler: (request: Request) => Promise<Response>;
        if (method === 'POST') {
          handler = post;
        } else if (method === 'GET' && path.endsWith('/health')) {
          handler = health;
        } else if (method === 'OPTIONS') {
          handler = combined.OPTIONS;
        } else {
          throw new Error(`Unsupported method/path: ${method} ${path}`);
        }

        const response = await handler(
          new Request(`http://localhost${path}`, {
            method,
            headers,
            body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
          }),
        );

        return {
          status: response.status,
          body: parseJsonBody(await response.text()),
          headers: Object.fromEntries(response.headers.entries()),
        };
      },
      requestSse: async (path, query) => {
        const url = query ? `${path}?${new URLSearchParams(query).toString()}` : path;
        const response = await stream(new Request(`http://localhost${url}`, { method: 'GET' }));

        if (response.status >= 400) {
          return { status: response.status, events: [] as SseEvent[] };
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

describe('@ottrix/nextjs contract harness', () => {
  it('loads the contract suite', () => {
    expect(runAdapterContractTests).toBeTypeOf('function');
  });

  it('builds a mock registry for health checks', async () => {
    const registry = createMockProviderRegistry({ providers: { primary: 'healthy' } });
    expect(registry.listRegisteredProviders()).toContain('primary');
  });
});

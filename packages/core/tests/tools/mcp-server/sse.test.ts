import { get as httpGet, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { describe, expect, it } from 'vitest';

import { FunctionTool } from '../../../src/tools/function-tool.js';
import { MCPServer } from '../../../src/tools/mcp-server.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    new FunctionTool({
      name: 'add',
      description: 'Adds numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: async (input: Record<string, unknown>) => Number(input.a) + Number(input.b),
    }),
  );
  return registry;
}

interface SseClient {
  endpoint: string;
  waitForMessage: (id: number | string) => Promise<Record<string, unknown>>;
  close: () => void;
}

function connectSse(baseUrl: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/sse`);
    const pending = new Map<number | string, (value: Record<string, unknown>) => void>();
    let endpoint = '';
    let buffer = '';

    const req = httpGet(url, (res) => {
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let splitIndex = buffer.indexOf('\n\n');
        while (splitIndex !== -1) {
          const block = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          const lines = block.split('\n');
          let eventName = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              data = line.slice(5).trim();
            }
          }
          if (eventName === 'endpoint') {
            endpoint = data;
          } else if (eventName === 'message' && data) {
            const payload = JSON.parse(data) as Record<string, unknown>;
            const waiter = pending.get(payload.id as number | string);
            if (waiter) {
              pending.delete(payload.id as number | string);
              waiter(payload);
            }
          }
          splitIndex = buffer.indexOf('\n\n');
        }
      });

      res.on('end', () => undefined);
    });

    req.on('error', reject);

    const interval = setInterval(() => {
      if (endpoint) {
        clearInterval(interval);
        resolve({
          endpoint,
          waitForMessage: (id) =>
            new Promise((resolveMessage, rejectMessage) => {
              const timer = setTimeout(
                () => rejectMessage(new Error(`Timed out waiting for id ${id}`)),
                5_000,
              );
              pending.set(id, (payload) => {
                clearTimeout(timer);
                resolveMessage(payload);
              });
            }),
          close: () => req.destroy(),
        });
      }
    }, 10);
  });
}

function postJson(url: string, body: unknown): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('MCPServer SSE transport', () => {
  it('serves initialize, tools/list, and tools/call over SSE + POST', async () => {
    const port = await getFreePort();
    const server = new MCPServer({
      name: 'sse-server',
      version: '1.0.0',
      toolRegistry: createRegistry(),
      transport: 'sse',
      port,
      host: '127.0.0.1',
    });

    await server.start();
    const baseUrl = server.getBaseUrl()!;
    const client = await connectSse(baseUrl);

    const initPromise = client.waitForMessage(1);
    const initPost = postJson(client.endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sse-client', version: '1.0.0' },
      },
    });
    expect((await initPost).statusCode).toBe(202);
    const init = await initPromise;
    expect(init.result).toMatchObject({ serverInfo: { name: 'sse-server' } });

    await postJson(client.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });

    const listPromise = client.waitForMessage(2);
    await postJson(client.endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await listPromise;
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['add']);

    const callPromise = client.waitForMessage(3);
    await postJson(client.endpoint, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 3 } },
    });
    const call = await callPromise;
    const result = call.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ success: true, output: 5 });

    client.close();
    await server.stop();
  });

  it('tracks multiple concurrent SSE clients independently', async () => {
    const port = await getFreePort();
    const server = new MCPServer({
      name: 'sse-server',
      version: '1.0.0',
      toolRegistry: createRegistry(),
      transport: 'sse',
      port,
      host: '127.0.0.1',
    });

    await server.start();
    const baseUrl = server.getBaseUrl()!;

    const clientA = await connectSse(baseUrl);
    const clientB = await connectSse(baseUrl);
    expect(server.getConnectedClients()).toBe(2);

    await postJson(clientA.endpoint, {
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'client-a', version: '1.0.0' },
      },
    });
    await postJson(clientA.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
    await postJson(clientB.endpoint, {
      jsonrpc: '2.0',
      id: 20,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'client-b', version: '1.0.0' },
      },
    });
    await postJson(clientB.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });

    const responseA = clientA.waitForMessage(11);
    const responseB = clientB.waitForMessage(21);

    await postJson(clientA.endpoint, { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} });
    await postJson(clientB.endpoint, { jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} });

    const listA = await responseA;
    const listB = await responseB;
    expect(listA.id).toBe(11);
    expect(listB.id).toBe(21);
    expect((listA.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'add',
    ]);
    expect((listB.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'add',
    ]);

    clientA.close();
    clientB.close();
    await server.stop();
  });

  it('returns parse error for invalid JSON bodies', async () => {
    const port = await getFreePort();
    const server = new MCPServer({
      name: 'sse-server',
      version: '1.0.0',
      toolRegistry: createRegistry(),
      transport: 'sse',
      port,
      host: '127.0.0.1',
    });

    await server.start();
    const baseUrl = server.getBaseUrl()!;
    const client = await connectSse(baseUrl);

    const errorPromise = client.waitForMessage(0);
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(client.endpoint);
      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.write('not-json');
      req.end();
    });

    const error = await errorPromise;
    expect(error.error).toMatchObject({ code: -32700 });

    client.close();
    await server.stop();
  });
});

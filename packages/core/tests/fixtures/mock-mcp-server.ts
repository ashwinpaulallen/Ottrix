import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { MCPToolDefinition } from '../../src/tools/mcp/types.js';

/** Default tools exposed by the mock MCP server. */
export const mockMcpTools: MCPToolDefinition[] = [
  {
    name: 'echo',
    description: 'Echoes the input message',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  },
];

export interface MockMcpServerOptions {
  sseUrl?: string;
  messageUrl?: string;
  tools?: MCPToolDefinition[];
  /** Custom tool call handler; default implements echo and add. */
  onToolCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => { content: Array<{ type: string; text: string }>; isError?: boolean };
}

function defaultToolHandler(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError: boolean } {
  if (name === 'echo') {
    const message = typeof args.message === 'string' ? args.message : '';
    return { content: [{ type: 'text', text: message }], isError: false };
  }
  if (name === 'add') {
    const a = typeof args.a === 'number' ? args.a : 0;
    const b = typeof args.b === 'number' ? args.b : 0;
    return { content: [{ type: 'text', text: String(a + b) }], isError: false };
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

function encodeSseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** Handle a single JSON-RPC line and return a response line (or null for notifications). */
export function handleMockMcpJsonRpc(
  line: string,
  options: Pick<MockMcpServerOptions, 'tools' | 'onToolCall'> = {},
): string | null {
  const tools = options.tools ?? mockMcpTools;
  const onToolCall = options.onToolCall ?? defaultToolHandler;

  const message = JSON.parse(line) as {
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
  };

  if (message.method === 'notifications/initialized') {
    return null;
  }

  let result: unknown;

  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call': {
      const params = message.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      result = onToolCall(name, args);
      break;
    }
    default:
      return JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }

  if (message.id === undefined) {
    return null;
  }

  return JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
}

/**
 * Create a mock `fetch` for MCP HTTP+SSE integration tests.
 *
 * - GET `sseUrl` opens an SSE stream with an `endpoint` event.
 * - POST `messageUrl` handles JSON-RPC (initialize, tools/list, tools/call).
 */
export function createMockMcpFetch(options: MockMcpServerOptions = {}): typeof fetch {
  const sseUrl = options.sseUrl ?? 'http://localhost:3000/sse';
  const messageUrl = options.messageUrl ?? 'http://localhost:3000/messages';

  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url === sseUrl) {
      const body = encodeSseEvent('endpoint', messageUrl);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (method === 'POST' && url === messageUrl) {
      const raw = init?.body;
      const text = typeof raw === 'string' ? raw : raw ? await new Response(raw).text() : '';
      const message = JSON.parse(text) as { id?: number | string; method: string };

      if (message.method === 'notifications/initialized' || message.id === undefined) {
        return new Response(null, { status: 202 });
      }

      const responseLine = handleMockMcpJsonRpc(text, options);
      if (!responseLine) {
        return new Response(null, { status: 202 });
      }

      return new Response(responseLine, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  });
}

/**
 * In-memory stdio streams for testing {@link StdioMCPTransport} without spawning processes.
 */
export function createMockStdioStreams(): {
  streams: {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    kill: () => void;
  };
  serverWrite: (line: string) => void;
  onClientMessage: (handler: (line: string) => void) => void;
} {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  let messageHandler: ((line: string) => void) | undefined;

  clientToServer.on('data', (chunk: Buffer) => {
    messageHandler?.(chunk.toString());
  });

  return {
    streams: {
      stdin: clientToServer,
      stdout: serverToClient,
      kill: () => {
        clientToServer.end();
        serverToClient.end();
      },
    },
    serverWrite: (line: string) => {
      serverToClient.write(`${line}\n`);
    },
    onClientMessage: (handler) => {
      messageHandler = handler;
    },
  };
}

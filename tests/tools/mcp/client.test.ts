import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/tools/mcp/client.js';
import { StdioMCPTransport } from '../../../src/tools/mcp/stdio-transport.js';
import {
  createMockMcpFetch,
  createMockStdioStreams,
  handleMockMcpJsonRpc,
} from '../../fixtures/mock-mcp-server.js';

const SSE_URL = 'http://localhost:3000/sse';
const MESSAGE_URL = 'http://localhost:3000/messages';

describe('MCPClient (SSE)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createMockMcpFetch({ sseUrl: SSE_URL, messageUrl: MESSAGE_URL }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects with initialize handshake and lists tools', async () => {
    const client = new MCPClient({
      config: { transport: 'sse', url: SSE_URL },
    });

    const init = await client.connect();
    expect(init.serverInfo.name).toBe('mock-mcp-server');

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'add']);

    await client.disconnect();
  });

  it('calls a tool via tools/call and returns structured result', async () => {
    const client = new MCPClient({
      config: { transport: 'sse', url: SSE_URL },
    });

    await client.connect();
    const result = await client.callTool('add', { a: 10, b: 32 });
    expect(result).toEqual({
      content: [{ type: 'text', text: '42' }],
      isError: false,
    });

    await client.disconnect();
  });
});

describe('StdioMCPTransport', () => {
  it('exchanges JSON-RPC over injected stdin/stdout streams', async () => {
    const { streams, serverWrite, onClientMessage } = createMockStdioStreams();

    onClientMessage((line) => {
      const response = handleMockMcpJsonRpc(line);
      if (response) {
        serverWrite(response);
      }
    });

    const transport = new StdioMCPTransport({
      command: 'noop',
      streams,
    });

    await transport.connect();

    const initResponse = await transport.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    expect(JSON.parse(JSON.stringify(initResponse))).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'mock-mcp-server' } },
    });

    await transport.notify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    const listResponse = await transport.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const listParsed = JSON.parse(JSON.stringify(listResponse)) as {
      id: number;
      result: { tools: Array<{ name: string }> };
    };
    expect(listParsed.id).toBe(2);
    expect(listParsed.result.tools.some((t) => t.name === 'echo')).toBe(true);

    const callResponse = await transport.request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'ping' } },
    });

    expect(JSON.parse(JSON.stringify(callResponse))).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: 'ping' }] },
    });

    await transport.close();
  });
});

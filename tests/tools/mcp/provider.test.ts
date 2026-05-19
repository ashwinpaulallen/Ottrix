import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPRegistryConnectError } from '../../../src/tools/mcp/mcp-registry.js';
import { MCPToolProvider } from '../../../src/tools/mcp/provider.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { createMockMcpFetch } from '../../fixtures/mock-mcp-server.js';

const SSE_URL = 'http://localhost:3000/sse';
const MESSAGE_URL = 'http://localhost:3000/messages';

describe('MCPToolProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createMockMcpFetch({ sseUrl: SSE_URL, messageUrl: MESSAGE_URL }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects, discovers tools, and namespaces them', async () => {
    const provider = new MCPToolProvider({
      config: { transport: 'sse', url: SSE_URL },
      namespace: 'mock',
      reconnect: false,
    });

    const tools = await provider.connect();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(['mock.echo', 'mock.add']);
    expect(provider.getState()).toBe('connected');

    const echo = tools[0]!;
    const result = await echo.execute({ message: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });

    await provider.disconnect();
    expect(provider.getState()).toBe('disconnected');
    expect(provider.getTools()).toHaveLength(0);
  });
});

describe('MCPRegistry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createMockMcpFetch({ sseUrl: SSE_URL, messageUrl: MESSAGE_URL }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('manages multiple servers and registers namespaced tools', async () => {
    const { MCPRegistry } = await import('../../../src/tools/mcp/mcp-registry.js');
    const registry = new MCPRegistry();

    registry.addServer('alpha', { transport: 'sse', url: SSE_URL });
    registry.addServer('beta', { transport: 'sse', url: SSE_URL });

    await registry.connectAll();

    const tools = registry.getAllTools();
    expect(tools.length).toBe(4);
    expect(tools.some((t) => t.name === 'alpha.echo')).toBe(true);
    expect(tools.some((t) => t.name === 'beta.add')).toBe(true);

    const toolRegistry = new ToolRegistry();
    registry.registerAll(toolRegistry);
    expect(toolRegistry.has('alpha.add')).toBe(true);

    const result = await toolRegistry.execute('beta.add', { a: 1, b: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      content: [{ type: 'text', text: '3' }],
      isError: false,
    });

    await registry.removeServer('alpha');
    expect(registry.serverNames()).toEqual(['beta']);

    await registry.disconnectAll();
  });

  it('reports per-server failures via connectAll without aborting successful servers', async () => {
    const { MCPRegistry } = await import('../../../src/tools/mcp/mcp-registry.js');
    const registry = new MCPRegistry();

    registry.addServer('good', { transport: 'sse', url: SSE_URL });
    registry.addServer('bad', { transport: 'sse', url: 'http://localhost:3000/nonexistent' });

    const results = await registry.connectAll();
    expect(results.find((r) => r.name === 'good')?.status).toBe('fulfilled');
    expect(results.find((r) => r.name === 'bad')?.status).toBe('rejected');

    expect(registry.getProvider('good')?.getState()).toBe('connected');

    await registry.disconnectAll();
  });

  it('connectAll rolls back successful servers when throwOnFailure is set', async () => {
    const { MCPRegistry } = await import('../../../src/tools/mcp/mcp-registry.js');
    const registry = new MCPRegistry();

    registry.addServer('good', {
      config: { transport: 'sse', url: SSE_URL },
      providerOptions: { reconnect: false },
    });
    registry.addServer('bad', {
      config: { transport: 'sse', url: 'http://localhost:3000/nonexistent' },
      providerOptions: { reconnect: false },
    });

    await expect(registry.connectAll({ throwOnFailure: true })).rejects.toBeInstanceOf(
      MCPRegistryConnectError,
    );
    expect(registry.getProvider('good')?.getState()).toBe('disconnected');
  });
});

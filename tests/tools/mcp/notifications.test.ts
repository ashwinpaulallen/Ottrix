import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/tools/mcp/client.js';
import { MCPToolProvider } from '../../../src/tools/mcp/provider.js';
import { FakeMCPTransport } from '../../fixtures/fake-mcp-transport.js';

const FAKE_CONFIG = { transport: 'sse', url: 'http://unused' } as const;

describe('notifications/tools/list_changed', () => {
  it('MCPClient.onToolsChanged fires when the server pushes the notification', async () => {
    const transport = new FakeMCPTransport();
    const client = new MCPClient({ config: FAKE_CONFIG, transport });
    await client.connect();

    const listener = vi.fn();
    client.onToolsChanged(listener);

    transport.pushNotification({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });

    expect(listener).toHaveBeenCalledOnce();

    await client.disconnect();
  });

  it('MCPClient.onNotification receives any unsolicited notification', async () => {
    const transport = new FakeMCPTransport();
    const client = new MCPClient({ config: FAKE_CONFIG, transport });
    await client.connect();

    const listener = vi.fn();
    client.onNotification(listener);

    transport.pushNotification({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { ratio: 0.5 },
    });

    expect(listener).toHaveBeenCalledOnce();
    const arg = listener.mock.calls[0]![0] as { method: string };
    expect(arg.method).toBe('notifications/progress');

    await client.disconnect();
  });

  it('unsubscribe stops further notifications', async () => {
    const transport = new FakeMCPTransport();
    const client = new MCPClient({ config: FAKE_CONFIG, transport });
    await client.connect();

    const listener = vi.fn();
    const unsubscribe = client.onToolsChanged(listener);

    transport.pushNotification({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    unsubscribe();
    transport.pushNotification({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });

    expect(listener).toHaveBeenCalledOnce();

    await client.disconnect();
  });

  it('MCPToolProvider refreshes tools and emits onToolsChanged', async () => {
    const transport = new FakeMCPTransport({
      tools: [
        { name: 'a', description: 'first', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    const provider = new MCPToolProvider({
      config: FAKE_CONFIG,
      namespace: 'svr',
      reconnect: false,
      transport,
    });

    const tools = await provider.connect();
    expect(tools.map((t) => t.name)).toEqual(['svr.a']);

    const changed = vi.fn();
    provider.onToolsChanged(changed);

    transport.setTools([
      { name: 'a', description: 'first', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', description: 'second', inputSchema: { type: 'object', properties: {} } },
    ]);

    transport.pushNotification({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });

    // The notification handler triggers an async refresh; wait for it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(provider.getTools().map((t) => t.name)).toEqual(['svr.a', 'svr.b']);
    expect(changed).toHaveBeenCalledOnce();
    const emitted = changed.mock.calls[0]![0] as Array<{ name: string }>;
    expect(emitted.map((t) => t.name)).toEqual(['svr.a', 'svr.b']);

    await provider.disconnect();
  });

  it('MCPRegistry.bindTo keeps a ToolRegistry in sync', async () => {
    const { MCPRegistry } = await import('../../../src/tools/mcp/mcp-registry.js');
    const { ToolRegistry } = await import('../../../src/tools/registry.js');

    const transport = new FakeMCPTransport({
      tools: [
        { name: 'one', description: '1', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    const mcp = new MCPRegistry();
    mcp.addServer('srv', {
      config: FAKE_CONFIG,
      providerOptions: { transport, reconnect: false },
    });
    await mcp.connectAll();

    const toolRegistry = new ToolRegistry();
    const unbind = mcp.bindTo(toolRegistry);

    expect(toolRegistry.has('srv.one')).toBe(true);

    transport.setTools([
      { name: 'one', description: '1', inputSchema: { type: 'object', properties: {} } },
      { name: 'two', description: '2', inputSchema: { type: 'object', properties: {} } },
    ]);
    transport.pushNotification({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(toolRegistry.has('srv.two')).toBe(true);

    unbind();
    await mcp.disconnectAll();
  });

  it('MCP errors surface code/data through ToolResult.errorDetails', async () => {
    const transport = new FakeMCPTransport({
      tools: [
        {
          name: 'broken',
          description: 'always errors',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      onToolCall: () => ({
        content: [{ type: 'text', text: 'tool failed' }],
        isError: true,
      }),
    });

    const provider = new MCPToolProvider({
      config: FAKE_CONFIG,
      namespace: 'svr',
      reconnect: false,
      transport,
    });
    const [brokenTool] = await provider.connect();

    const result = await brokenTool!.execute({});
    expect(result.success).toBe(false);
    expect(result.errorDetails?.name).toBe('MCPToolError');
    expect(result.error).toBe('tool failed');

    await provider.disconnect();
  });
});

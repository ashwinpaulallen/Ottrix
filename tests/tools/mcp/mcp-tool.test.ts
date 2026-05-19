import { describe, expect, it } from 'vitest';
import { MCPClient } from '../../../src/tools/mcp/client.js';
import { MCPToolError } from '../../../src/tools/mcp/json-rpc.js';
import {
  createMCPTool,
  normalizeMcpInputSchema,
} from '../../../src/tools/mcp/mcp-tool.js';
import { MCPToolProvider } from '../../../src/tools/mcp/provider.js';
import { extractErrorDetails } from '../../../src/tools/tool.js';
import { FakeMCPTransport } from '../../fixtures/fake-mcp-transport.js';

const FAKE_CONFIG = { transport: 'sse', url: 'http://unused' } as const;

describe('normalizeMcpInputSchema', () => {
  it('adds type object when properties are present without type', () => {
    expect(
      normalizeMcpInputSchema({
        properties: { message: { type: 'string' } },
        required: ['message'],
      }),
    ).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('returns empty object schema for missing input', () => {
    expect(normalizeMcpInputSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('preserves schemas that already declare type', () => {
    const schema = { type: 'string' as const };
    expect(normalizeMcpInputSchema(schema)).toBe(schema);
  });
});

describe('createMCPTool', () => {
  it('supports approval gates via options', async () => {
    const transport = new FakeMCPTransport({
      tools: [{ name: 'run', description: 'run', inputSchema: { type: 'object', properties: {} } }],
    });
    const client = new MCPClient({ config: FAKE_CONFIG, transport });
    await client.connect();

    const tool = createMCPTool(
      { name: 'run', description: 'run', inputSchema: { type: 'object', properties: {} } },
      client,
      { requiresApproval: true },
    );

    expect(tool.requiresApproval).toBe(true);
    await client.disconnect();
  });
});

describe('MCPToolProvider refresh', () => {
  it('preserves requiresApproval across tool list refreshes', async () => {
    const transport = new FakeMCPTransport({
      tools: [{ name: 'a', description: 'first', inputSchema: { type: 'object', properties: {} } }],
    });

    const provider = new MCPToolProvider({
      config: FAKE_CONFIG,
      namespace: 'svr',
      reconnect: false,
      transport,
      toolDefaults: { requiresApproval: true },
    });

    await provider.connect();
    expect(provider.getTools()[0]?.requiresApproval).toBe(true);

    transport.setTools([
      { name: 'a', description: 'first', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', description: 'second', inputSchema: { type: 'object', properties: {} } },
    ]);
    await provider.refreshTools();

    const tools = provider.getTools();
    expect(tools.find((t) => t.name === 'svr.a')?.requiresApproval).toBe(true);
    expect(tools.find((t) => t.name === 'svr.b')?.requiresApproval).toBe(true);

    await provider.disconnect();
  });
});

describe('extractErrorDetails', () => {
  it('includes MCP tool result payload in errorDetails.data', () => {
    const error = new MCPToolError({
      content: [{ type: 'text', text: 'denied' }],
      isError: true,
    });
    const details = extractErrorDetails(error);
    expect(details.name).toBe('MCPToolError');
    expect(details.data).toMatchObject({
      result: { content: [{ type: 'text', text: 'denied' }], isError: true },
    });
  });
});

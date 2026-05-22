import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { FunctionTool } from '../../../src/tools/function-tool.js';
import { ASK_AGENT_TOOL_NAME, MCPServer } from '../../../src/tools/mcp-server.js';
import { McpStdioServerTransport } from '../../../src/tools/mcp-transports/stdio.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { AgentResult, AgentRunMetadata } from '../../../src/types/agent.js';

function createStdioHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: string[] = [];

  output.on('data', (chunk: Buffer | string) => {
    responses.push(typeof chunk === 'string' ? chunk : chunk.toString());
  });

  const transport = new McpStdioServerTransport({
    input,
    output,
    handleSignals: false,
  });

  return { input, output, responses, transport };
}

function writeJson(input: PassThrough, payload: unknown): void {
  input.write(`${JSON.stringify(payload)}\n`);
}

function parseLastResponse(responses: string[]): Record<string, unknown> {
  const line = responses.at(-1)?.trim();
  expect(line).toBeTruthy();
  return JSON.parse(line!) as Record<string, unknown>;
}

async function initializeStdioSession(input: PassThrough, responses: string[]): Promise<void> {
  writeJson(input, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  });
  await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));
  writeJson(input, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

function createEchoRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    new FunctionTool({
      name: 'echo',
      description: 'Echoes input',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      execute: async (input) => ({ echoed: input.message }),
    }),
  );
  return registry;
}

describe('MCPServer stdio transport', () => {
  it('handles initialize → initialized → tools/list → tools/call', async () => {
    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: createEchoRegistry(),
      transport: 'stdio',
      transportImpl: transport,
    });

    await server.start();

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));
    const init = parseLastResponse(responses);
    expect(init.result).toMatchObject({
      serverInfo: { name: 'test-server', version: '0.1.0' },
    });

    writeJson(input, { jsonrpc: '2.0', method: 'notifications/initialized' });

    writeJson(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(1));
    const list = parseLastResponse(responses);
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);

    writeJson(input, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'hello' } },
    });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(2));
    const call = parseLastResponse(responses);
    const result = call.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      output: { echoed: 'hello' },
    });

    await server.stop();
  });

  it('buffers partial stdin chunks before newline', async () => {
    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: createEchoRegistry(),
      transport: 'stdio',
      transportImpl: transport,
    });
    await server.start();

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    input.write(payload.slice(0, 10));
    input.write(payload.slice(10));
    input.write('\n');

    await vi.waitFor(() => expect(responses.length).toBe(1));
    expect(parseLastResponse(responses).id).toBe(10);

    await server.stop();
  });

  it('returns parse error for invalid JSON', async () => {
    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: new ToolRegistry(),
      transport: 'stdio',
      transportImpl: transport,
    });
    await server.start();

    input.write('not-json\n');
    await vi.waitFor(() => expect(responses.length).toBe(1));
    expect(parseLastResponse(responses).error).toMatchObject({ code: -32700 });

    await server.stop();
  });

  it('rejects tools/list before notifications/initialized', async () => {
    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: createEchoRegistry(),
      transport: 'stdio',
      transportImpl: transport,
    });
    await server.start();

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    await vi.waitFor(() => expect(responses.length).toBe(1));

    writeJson(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await vi.waitFor(() => expect(responses.length).toBe(2));
    expect(parseLastResponse(responses).error).toMatchObject({ code: -32002 });

    await server.stop();
  });

  it('returns method not found for unknown methods', async () => {
    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: new ToolRegistry(),
      transport: 'stdio',
      transportImpl: transport,
    });
    await server.start();

    writeJson(input, { jsonrpc: '2.0', id: 5, method: 'unknown/method', params: {} });
    await vi.waitFor(() => expect(responses.length).toBe(1));
    expect(parseLastResponse(responses).error).toMatchObject({ code: -32601 });

    await server.stop();
  });

  it('returns tool execution errors with isError true', async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'fail',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          throw new Error('boom');
        },
      }),
    );

    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: registry,
      transport: 'stdio',
      transportImpl: transport,
    });
    await server.start();
    await initializeStdioSession(input, responses);

    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail', arguments: {} },
    });
    await vi.waitFor(() => expect(responses.length).toBe(2));
    const result = parseLastResponse(responses).result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('boom');

    await server.stop();
  });

  it('exposes ask_agent when an agent is configured', async () => {
    const agent = {
      run: vi.fn(async (): Promise<AgentResult<AgentRunMetadata>> => ({
        response: 'agent says hi',
        steps: [],
        totalTokens: { input: 1, output: 1, total: 2 },
        metadata: { stopReason: 'completed' },
      })),
    };

    const { input, responses, transport } = createStdioHarness();
    const server = new MCPServer({
      name: 'test-server',
      version: '0.1.0',
      toolRegistry: new ToolRegistry(),
      transport: 'stdio',
      transportImpl: transport,
      agent: agent as never,
    });
    await server.start();
    await initializeStdioSession(input, responses);

    writeJson(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(1));
    const tools = (parseLastResponse(responses).result as { tools: Array<{ name: string }> }).tools;
    expect(tools.some((tool) => tool.name === ASK_AGENT_TOOL_NAME)).toBe(true);

    writeJson(input, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: ASK_AGENT_TOOL_NAME, arguments: { message: 'hello agent' } },
    });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(2));
    const result = parseLastResponse(responses).result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      success: true,
      output: { response: 'agent says hi' },
    });
    expect(agent.run).toHaveBeenCalledWith('hello agent');

    await server.stop();
  });
});

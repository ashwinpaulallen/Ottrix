/**
 * MCP integration example (in-memory demo server).
 *
 * Production setup (commented below):
 *   - Stdio: spawn an MCP server process (e.g. npx @modelcontextprotocol/server-filesystem)
 *   - SSE: connect to an HTTP+SSE endpoint exposed by the server
 */
import { Agent, MCPToolProvider, ToolRegistry } from 'ottrix';
import { DemoProvider, demoToolUse } from '../shared/demo-provider.js';
import { DemoMcpTransport } from './demo-mcp-transport.js';

// Tools advertised by our demo MCP server (would come from tools/list in production).
const demoTools = [
  {
    name: 'get_time',
    description: 'Returns the current ISO timestamp',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Hypothetical real server config (not used when `transport` is injected):
// const serverConfig = {
//   transport: 'stdio' as const,
//   command: 'npx',
//   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
// };

const mcp = new MCPToolProvider({
  config: { transport: 'stdio', command: 'demo-mcp', args: [] },
  transport: new DemoMcpTransport(demoTools),
  namespace: 'demo',
  reconnect: false,
});

console.log('Connecting to demo MCP server…');
const tools = await mcp.connect();
console.log(
  'Discovered tools:',
  tools.map((t) => t.name),
);

const registry = new ToolRegistry();
for (const tool of tools) {
  registry.register(tool);
}

const provider = new DemoProvider()
  .enqueue(demoToolUse([{ id: 'tu_1', name: 'demo.get_time', input: {} }]))
  .textReply('The MCP get_time tool returned a timestamp (see trace).');

const agent = new Agent({
  name: 'mcp-agent',
  provider,
  toolRegistry: registry,
  systemPrompt: 'You may call MCP tools when helpful.',
});

const result = await agent.run('What time is it? Use the MCP tool.');

console.log('\n--- Response ---\n');
console.log(result.response);

await mcp.disconnect();
console.log('\nDisconnected from MCP server.');

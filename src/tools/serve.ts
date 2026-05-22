import { MCPServer, type MCPServerOptions } from './mcp-server.js';

/** Configuration for {@link serveMCP}. */
export type ServeMCPConfig = MCPServerOptions;

/**
 * Create and start an MCP server exposing the given tool registry.
 *
 * @example
 * ```ts
 * import { serveMCP, ToolRegistry, FunctionTool } from 'agent-kit';
 *
 * const registry = new ToolRegistry();
 * registry.register(myTool);
 * await serveMCP({ name: 'my-tools', version: '1.0.0', toolRegistry: registry, transport: 'stdio' });
 * ```
 */
export async function serveMCP(config: ServeMCPConfig): Promise<MCPServer> {
  const server = new MCPServer(config);
  await server.start();
  return server;
}

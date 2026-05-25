import { MCPServer, type MCPServerOptions } from './server.js';

/** Configuration for {@link serveMCP}. */
export type ServeMCPConfig = MCPServerOptions;

/** Create and start an MCP server exposing the given tool registry. */
export async function serveMCP(config: ServeMCPConfig): Promise<MCPServer> {
  const server = new MCPServer(config);
  await server.start();
  return server;
}

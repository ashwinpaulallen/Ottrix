# MCP integration

Connects to a **demo in-memory MCP server**, discovers tools, and runs an agent that calls them.

## What it demonstrates

- `MCPToolProvider.connect()` → `tools/list`
- Registering dynamic MCP tools on `ToolRegistry`
- Namespaced tool names (`demo.get_time`)
- Injecting a custom `MCPTransport` for local demos (no subprocess)

## Production MCP setup

Replace the injected `DemoMcpTransport` with a real transport:

| Transport | Config shape |
|-----------|----------------|
| **stdio** | `{ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'] }` |
| **SSE** | `{ transport: 'sse', url: 'http://localhost:3000/sse' }` |

Set any API keys your MCP server needs in the environment (this example uses none).

## Run

```bash
npm run build   # from repo root
cd examples/mcp-integration
npm install
npm start
```

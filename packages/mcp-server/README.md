# @ottrix/mcp-server

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Expose ottrix tools as an [MCP](https://modelcontextprotocol.io/) server so Claude Desktop, Cursor, and other MCP clients can call your tools.

This is the **reverse** of ottrix core's MCP **client** (`MCPClient`, `MCPToolProvider`) — core connects *to* external MCP servers; this package lets others connect *to* your ottrix tools.

## Install

```bash
npm install @ottrix/mcp-server ottrix
```

## Programmatic use

```typescript
import { FunctionTool, ToolRegistry } from 'ottrix';
import { serveMCP } from '@ottrix/mcp-server';

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

await serveMCP({
  name: 'my-tools',
  version: '1.0.0',
  toolRegistry: registry,
  transport: 'stdio',
});
```

## CLI

```bash
npx ottrix-serve --transport stdio
npx ottrix-serve --transport sse --port 3001
npx ottrix-serve --config ./mcp.config.mjs
```

Config module example:

```javascript
import { FunctionTool } from 'ottrix';

export default {
  name: 'my-tools',
  transport: 'stdio',
  setup({ registry }) {
    registry.register(/* ... */);
  },
};
```

## Transports

| Transport | Use case |
|-----------|----------|
| **stdio** | Claude Desktop, local subprocess clients |
| **SSE** | HTTP clients — `GET /sse` + `POST /message?sessionId=…` |

## Exports

- `MCPServer` — protocol handler with stdio/SSE transports
- `serveMCP()` — create and start in one call
- `McpStdioServerTransport`, `McpSseServerTransport` — advanced composition
- `ASK_AGENT_TOOL_NAME` — optional meta-tool when an `Agent` is passed to `MCPServer`

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | Tools, `ToolRegistry`, MCP **client** (`MCPClient`) |
| **`@ottrix/exporter-*`** | Trace export to Langfuse, OTel, Braintrust |
| **`@ottrix/nestjs`** / **express** / **fastify** / **hono** | HTTP APIs that use ottrix agents |

See [docs/README.md](../../docs/README.md).

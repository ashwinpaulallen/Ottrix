# Tools

Source: `src/tools/`

## `BaseTool`

**File:** `src/tools/tool.ts`

| Constant | Value |
|----------|-------|
| `DEFAULT_TOOL_TIMEOUT_MS` | `30_000` |

### Config (`BaseToolConfig`)

Required: `name`, `description`, `inputSchema` (JSON Schema).  
Optional: `metadata`, `timeoutMs`, `events` (`onStart`, `onComplete`, `onError`).

### `execute(input)`

1. Validates input via `validateSchema` from `src/utils/schema-validator.ts`
2. On validation failure → returns `{ success: false, error, errorDetails }` (**does not throw**)
3. On success → `{ success: true, output }`
4. Execution errors caught → failed `ToolResult`
5. Timeout → rejection message `Tool "{name}" timed out after {timeoutMs}ms`

### `toDefinition()`

Returns `{ name, description, inputSchema, metadata? }`.

### `ToolValidationError`

- `errors: string[]`
- Message: errors joined with `; `

### `extractErrorDetails(error)`

Maps validation errors; for `Error`, picks numeric `code` and `data` if present on the object.

---

## `FunctionTool`

**File:** `src/tools/function-tool.ts`

Extends `BaseTool`. Config adds `execute: (input) => Promise<unknown>`.  
`_execute` calls the provided function.

---

## `ToolRegistry`

**File:** `src/tools/registry.ts`

| Option | Default |
|--------|---------|
| `onDuplicate` (register) | `'overwrite'` |
| Telemetry `component` | `'tools'` |

### Duplicate registration

| Strategy | Behavior |
|----------|----------|
| `overwrite` | Replace existing |
| `ignore` | No-op if exists |
| `throw` | `DuplicateToolError` |

### Methods

| Method | Behavior |
|--------|----------|
| `register(tool, options?)` | Add tool |
| `unregister(name)` | Remove by name |
| `get(name)` | Get tool or undefined |
| `has(name)` | Boolean |
| `list()` | All `ToolDefinition[]` |
| `names()` | Tool names |
| `execute(name, input)` | Throws `ToolNotFoundError` if missing; optional telemetry span |
| `registerFromSchema(schema, executor)` | Creates `FunctionTool` |
| `listByNamespace(namespace)` | Names with prefix `{namespace}.` |
| `unregisterNamespace(namespace)` | Remove all in namespace; returns count |
| `usesTelemetry(telemetry)` | Whether this registry is instrumented |

Constructor option `cloneFrom` copies tools from another registry.

### Error classes

| Class | When |
|-------|------|
| `DuplicateToolError` | Register with `onDuplicate: 'throw'` and name exists |
| `ToolNotFoundError` | `execute` for unknown name |

---

## MCP protocol

**Files:** `src/tools/mcp/*`

| Constant | Value |
|----------|-------|
| `MCP_PROTOCOL_VERSION` | `2024-11-05` |

### Server config (discriminated union)

**SSE:** `{ transport: 'sse', url, headers?, requestTimeoutMs? }`  
**Stdio:** `{ transport: 'stdio', command, args?, env?, cwd?, requestTimeoutMs? }`

### Connection states

`disconnected` · `connecting` · `connected` · `reconnecting`

### JSON-RPC (`json-rpc.ts`)

| Class / function | Purpose |
|------------------|---------|
| `RequestIdGenerator` | Monotonic ids starting at 1 |
| `MCPProtocolError` | Protocol failures (`code: number`, optional `data`) |
| `MCPToolError` | Tool result with `isError: true` |
| `buildRequest`, `buildNotification` | Construct messages |
| `parseJsonRpcMessage` | Validate shape; throws `MCPProtocolError` on invalid |
| `assertJsonRpcSuccess` | Throws `MCPProtocolError` from response.error |
| `normalizeToolCallResult` | Throws `MCPToolError` if `isError` |
| `extractTextContent` | Join `type: 'text'` blocks |
| `serializeMessage` / `parseMessageLine` | Stdio newline-delimited JSON |

### `MCPTransport` interface

`connect`, `request`, `notify`, `onMessage`, `close`, `isConnected`, `onDisconnect`

### Stdio transport

| Default | Value |
|---------|-------|
| `requestTimeoutMs` | `30_000` |
| `shutdownGracePeriodMs` | `1_000` |
| `args` | `[]` |

Spawns subprocess; newline JSON-RPC on stdin/stdout; stderr ignored.  
Errors: `Error` when not connected or invalid request id.

### SSE transport

| Default | Value |
|---------|-------|
| `requestTimeoutMs` | `30_000` |
| `connectTimeoutMs` | `30_000` |

GET SSE stream → wait for `endpoint` event → POST JSON-RPC to message URL.  
Errors: HTTP failures, stream closed before endpoint, not connected.

---

## `MCPClient`

**File:** `src/tools/mcp/client.ts`

| Default | Value |
|---------|-------|
| `clientInfo` | `{ name: 'agent-kit', version: '1.0.0' }` |
| `requestTimeoutMs` | `30_000` |

| Method | Behavior |
|--------|----------|
| `connect()` | Initialize handshake; `notifications/initialized`; cache result |
| `listTools()` | Paginated `tools/list` until no `nextCursor` |
| `callTool(name, args)` | `tools/call`; throws `MCPToolError` or `MCPProtocolError` |
| `disconnect()` | Close transport |
| `onToolsChanged(handler)` | `notifications/tools/list_changed` |
| `onNotification(handler)` | All notifications; listener errors swallowed |
| `ensureConnected()` | Auto-`connect()` if needed |

---

## `MCPTool` / `createMCPTool`

Wraps MCP tool as `BaseTool`. `_execute` → `client.callTool(mcpToolName, input)`.

`createMCPTool(definition, client, options?)`:

- Name: `{namespace}.{definition.name}` if namespace set
- Description default: `MCP tool: {name}`
- Schema default: `{ type: 'object', properties: {} }`

---

## `MCPToolProvider`

**File:** `src/tools/mcp/provider.ts`

| Reconnect default | Value |
|-------------------|-------|
| `enabled` | `true` |
| `maxAttempts` | `0` (unlimited) |
| `initialDelayMs` | `1_000` |
| `maxDelayMs` | `30_000` |
| `namespace` | `'mcp'` |

| Method | Behavior |
|--------|----------|
| `connect()` | Handshake, register tools, subscribe to list-changed |
| `refreshTools()` | Re-list and rebuild tool cache |
| `disconnect()` | Stop reconnect; clear tools |
| `getTools()` | Copy of cached tools (empty until connected) |

Injected `transport` option bypasses stdio/SSE factory (used in examples).

---

## `MCPRegistry`

| Method | Behavior |
|--------|----------|
| `addServer(name, config)` | Creates `MCPToolProvider` with `namespace: name` |
| `connectAll({ throwOnFailure? })` | Parallel connect; default returns per-server status array |
| `getAllTools()` | Concatenate all provider tools |
| `registerAll(registry)` | Register every tool |
| `bindTo(registry)` | Register + sync on `onToolsChanged`; returns unsubscribe |

`MCPRegistryConnectError` when `throwOnFailure: true` and any server fails.

---

## Schema validation

`validateSchema` exported from `agent-kit/tools` (implemented in `src/utils/schema-validator.ts`).

---

## Zod tools (`createTool`, `ZodTool`)

**File:** `src/tools/zod-tool.ts`

Define tools with Zod input/output schemas. JSON Schema for the LLM is generated via `zodToJsonSchema`.

```ts
import { createTool } from 'agent-kit';
import { z } from 'zod';

const weather = createTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  input: z.object({ city: z.string() }),
  output: z.object({ tempF: z.number() }).optional(),
  execute: async ({ city }) => ({ tempF: 72 }),
});
```

| Behavior | Detail |
|----------|--------|
| Input validation | Zod `safeParse` before execute |
| Output validation | Optional Zod schema on return value |
| `zodSchema` | Original Zod input schema on `ZodTool` instance |
| `isZodTool(tool)` | Type guard |

Requires optional peer **`zod`**.

---

## Tool approval (human-in-the-loop)

**Files:** `src/tools/tool-approval.ts`, `src/tools/approval-handlers.ts`, `src/tools/registry.ts`

Tools with `metadata.requiresApproval: true` pause execution until an `ApprovalHandler` responds.

| API | Purpose |
|-----|---------|
| `ToolRegistry.setApprovalHandler(handler)` | Global handler for all approval-gated tools |
| `ToolRegistry.setToolApprovalHandler(name, handler)` | Per-tool override |
| `createCliApprovalHandler()` | Terminal y/n prompt |
| `createAutoApproveHandler()` | Always approve (tests) |
| `createCallbackApprovalHandler(fn)` | Custom logic |

**Approval flow:**

1. Registry builds `ApprovalRequest` with tool name, input, agent name, step number
2. Handler returns `{ approved, reason?, modifiedInput? }`
3. Denial → `buildToolApprovalDeniedResult`; agent receives `tool_denied` stream event
4. Approval with `modifiedInput` → executes with adjusted input

**Helpers:** `isToolApprovalDenied`, `buildToolApprovalDenialMessage`, `getToolApprovalDenialReason`

Distinct from **`HumanApprovalGuardrail`** (guardrail middleware) — registry approval runs inside tool execution before `_execute`.

---

## MCP server (`MCPServer`, `serveMCP`)

**Files:** `src/tools/mcp-server.ts`, `src/tools/serve.ts`, `src/tools/mcp-transports/*`

Expose a `ToolRegistry` (and optionally an `Agent` via `ask_agent` meta-tool) to external MCP clients.

```ts
import { serveMCP, ToolRegistry } from 'agent-kit/mcp-server';

await serveMCP({
  name: 'my-tools',
  version: '1.0.0',
  toolRegistry: registry,
  transport: 'stdio', // or 'sse' with port/host
  agent: optionalAgent, // adds ASK_AGENT_TOOL_NAME = 'ask_agent'
});
```

| Transport | Behavior |
|-----------|----------|
| `stdio` | Newline-delimited JSON-RPC on stdin/stdout |
| `sse` | HTTP+SSE; default port **3001**, host **127.0.0.1** |

**CLI:** `npx agent-kit-serve --transport stdio` (see `src/cli/serve.ts`)

**Subpath:** `agent-kit/mcp-server` — lightweight import without full tools barrel.

**Errors:** `MCPProtocolError`, `ConfigurationError` for invalid server config.

---

## Subpath `agent-kit/tools`

Exports tools, registry errors, MCP **client** provider/registry, transports, JSON-RPC types, Zod tools, approval handlers.

**Subpath `agent-kit/mcp-server`:** `MCPServer`, `serveMCP`, `ASK_AGENT_TOOL_NAME` only.

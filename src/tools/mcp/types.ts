import type { JSONSchema } from '../../types/tools.js';

/** MCP protocol version used for the initialize handshake. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC 2.0 request message. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response message. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** JSON-RPC error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Any inbound JSON-RPC message from an MCP server. */
export type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

/** Tool definition returned by `tools/list`. */
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
  title?: string;
}

/** Result of the `initialize` request. */
export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
}

/** Result payload from `tools/list`. */
export interface MCPToolsListResult {
  tools: MCPToolDefinition[];
  nextCursor?: string;
}

/** Content block in a `tools/call` result (2024-11-05). */
export interface MCPToolContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Result payload from `tools/call`. */
export interface MCPToolCallResult {
  content?: MCPToolContentBlock[];
  isError?: boolean;
  resultType?: string;
  [key: string]: unknown;
}

/** SSE transport configuration. */
export interface MCPSseServerConfig {
  transport: 'sse';
  /** SSE endpoint URL (GET). Often ends with `/sse`. */
  url: string;
  /** Optional headers for SSE and POST requests. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. @defaultValue 30000 */
  requestTimeoutMs?: number;
}

/** Stdio transport configuration. */
export interface MCPStdioServerConfig {
  transport: 'stdio';
  /** Executable command. */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  /** Request timeout in milliseconds. @defaultValue 30000 */
  requestTimeoutMs?: number;
}

/** Discriminated union of MCP server connection configs. */
export type MCPServerConfig = MCPSseServerConfig | MCPStdioServerConfig;

/** Reconnection policy for {@link MCPToolProvider}. */
export interface MCPReconnectOptions {
  /** Whether to reconnect after disconnect. @defaultValue true */
  enabled?: boolean;
  /** Maximum reconnect attempts (0 = unlimited). @defaultValue 0 */
  maxAttempts?: number;
  /** Initial backoff delay in ms. @defaultValue 1000 */
  initialDelayMs?: number;
  /** Maximum backoff delay in ms. @defaultValue 30000 */
  maxDelayMs?: number;
}

/** Client identity sent during `initialize`. */
export interface MCPClientInfo {
  name: string;
  version: string;
}

/** Options for {@link MCPClient}. */
export interface MCPClientOptions {
  config: MCPServerConfig;
  clientInfo?: MCPClientInfo;
  /** Custom fetch implementation (SSE transport). */
  fetch?: typeof fetch;
  /** Custom child_process.spawn (stdio transport). */
  spawn?: typeof import('node:child_process').spawn;
  /** Default request timeout in ms. @defaultValue 30000 */
  requestTimeoutMs?: number;
  /**
   * Pre-built transport instance to use instead of constructing one from
   * `config`. Primarily useful for testing or custom transports.
   */
  transport?: import('./transport.js').MCPTransport;
}

/** Options for {@link MCPToolProvider}. */
export interface MCPToolProviderOptions {
  config: MCPServerConfig;
  /** Namespace prefix for tool names (e.g. `weather` → `weather.get_weather`). */
  namespace?: string;
  clientInfo?: MCPClientInfo;
  reconnect?: boolean | MCPReconnectOptions;
  fetch?: typeof fetch;
  spawn?: typeof import('node:child_process').spawn;
  requestTimeoutMs?: number;
  /**
   * Pre-built transport instance. When supplied it is forwarded to the
   * underlying {@link MCPClient}. Useful for testing.
   */
  transport?: import('./transport.js').MCPTransport;
}

/** Connection state for an MCP provider. */
export type MCPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

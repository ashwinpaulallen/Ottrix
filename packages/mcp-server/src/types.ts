import type { JSONSchema } from 'ottrix';

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

/** Tool definition returned by `tools/list`. */
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
  title?: string;
}

/** Content block in a `tools/call` result. */
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

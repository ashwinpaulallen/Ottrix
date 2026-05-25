import type { JsonRpcNotification, JsonRpcRequest } from './types.js';

/** JSON-RPC / MCP protocol error. */
export class MCPProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'MCPProtocolError';
    this.code = code;
    this.data = data;
  }
}

/** Type guard for JSON-RPC notifications. */
export function isJsonRpcNotification(
  message: JsonRpcRequest | JsonRpcNotification,
): message is JsonRpcNotification {
  return 'method' in message && !('id' in message && message.id !== undefined);
}

/**
 * Parse a client-originated JSON-RPC request or notification (server read path).
 */
export function parseInboundJsonRpcMessage(text: string): JsonRpcRequest | JsonRpcNotification {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new MCPProtocolError('Invalid JSON-RPC message: not an object', -32700);
  }
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') {
    throw new MCPProtocolError('Invalid JSON-RPC message: missing jsonrpc 2.0', -32600);
  }
  if ('method' in record && record.id !== undefined) {
    return parsed as JsonRpcRequest;
  }
  if ('method' in record && !('id' in record && record.id !== undefined)) {
    return parsed as JsonRpcNotification;
  }
  throw new MCPProtocolError('Invalid JSON-RPC message: unrecognized shape', -32600);
}

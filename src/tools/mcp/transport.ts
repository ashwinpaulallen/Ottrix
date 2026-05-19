import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from './types.js';

/**
 * Pluggable transport for MCP JSON-RPC message exchange.
 */
export interface MCPTransport {
  /** Establish the transport connection. */
  connect(): Promise<void>;
  /** Send a JSON-RPC request and await its response. */
  request(message: JsonRpcRequest): Promise<JsonRpcMessage>;
  /** Send a JSON-RPC notification (no response). */
  notify(message: JsonRpcNotification): Promise<void>;
  /** Register a handler for unsolicited server messages. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  /** Close the transport and release resources. */
  close(): Promise<void>;
  /** Whether the transport is currently connected. */
  isConnected(): boolean;
  /** Register a handler invoked when the transport disconnects unexpectedly. */
  onDisconnect(handler: (error?: Error) => void): void;
}

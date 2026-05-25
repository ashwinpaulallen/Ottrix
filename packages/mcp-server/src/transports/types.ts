import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from '../types.js';

/** Parsed inbound JSON-RPC message from an MCP client. */
export type MCPServerInboundMessage = JsonRpcRequest | JsonRpcNotification;

/** Callback invoked when the server should emit a JSON-RPC response. */
export type MCPServerReplyFn = (response: JsonRpcResponse) => void;

/** Per-connection state tracked by {@link MCPServer}. */
export interface MCPServerSession {
  id: string;
  initialized: boolean;
}

/** Handler wired from {@link MCPServer} into a transport implementation. */
export type MCPServerMessageHandler = (
  message: MCPServerInboundMessage,
  reply: MCPServerReplyFn,
  session: MCPServerSession,
) => void | Promise<void>;

/** Minimal surface implemented by stdio and SSE server transports. */
export interface MCPServerTransport {
  start(
    handler: MCPServerMessageHandler,
    options?: { onSessionConnect?: (session: MCPServerSession) => void },
  ): Promise<void>;
  stop(): Promise<void>;
  getConnectedClients(): number;
}

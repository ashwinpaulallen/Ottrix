import type { MCPTransport } from '../../src/tools/mcp/transport.js';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  MCPToolDefinition,
} from '../../src/tools/mcp/types.js';
import { mockMcpTools } from './mock-mcp-server.js';

/** Configuration for {@link FakeMCPTransport}. */
export interface FakeMCPTransportOptions {
  /** Override the tool set returned by `tools/list`. */
  tools?: MCPToolDefinition[];
  /** Custom handler for `tools/call`. */
  onToolCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => { content: Array<{ type: string; text?: string }>; isError?: boolean };
}

/**
 * In-memory {@link MCPTransport} that talks a minimal MCP protocol.
 *
 * Useful for tests that need to push synthetic notifications into the client.
 */
export class FakeMCPTransport implements MCPTransport {
  private connected = false;
  private messageHandler?: (message: JsonRpcMessage) => void;
  private readonly disconnectHandlers: Array<(error?: Error) => void> = [];
  private tools: MCPToolDefinition[];
  private readonly onToolCall: NonNullable<FakeMCPTransportOptions['onToolCall']>;

  constructor(options: FakeMCPTransportOptions = {}) {
    this.tools = [...(options.tools ?? mockMcpTools)];
    this.onToolCall =
      options.onToolCall ??
      ((name, args) => ({
        content: [
          {
            type: 'text',
            text: `${name}:${JSON.stringify(args)}`,
          },
        ],
        isError: false,
      }));
  }

  /** Replace the advertised tool set (does not auto-notify). */
  setTools(tools: MCPToolDefinition[]): void {
    this.tools = [...tools];
  }

  /** Push a synthetic JSON-RPC notification to the connected client. */
  pushNotification(notification: JsonRpcNotification): void {
    this.messageHandler?.(notification);
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  request(message: JsonRpcRequest): Promise<JsonRpcMessage> {
    if (!this.connected) {
      return Promise.reject(new Error('FakeMCPTransport is not connected'));
    }

    const id = message.id;
    if (id === undefined) {
      return Promise.reject(new Error('JSON-RPC request requires an id'));
    }

    let result: unknown;
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        };
        break;
      case 'tools/list':
        result = { tools: this.tools };
        break;
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        result = this.onToolCall(name, args);
        break;
      }
      default:
        return Promise.resolve({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
    }

    return Promise.resolve({ jsonrpc: '2.0', id, result });
  }

  notify(): Promise<void> {
    return Promise.resolve();
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onDisconnect(handler: (error?: Error) => void): void {
    this.disconnectHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): Promise<void> {
    this.connected = false;
    this.messageHandler = undefined;
    return Promise.resolve();
  }

  /** Simulate an unexpected disconnect. */
  triggerDisconnect(error?: Error): void {
    this.connected = false;
    for (const handler of this.disconnectHandlers) {
      handler(error);
    }
  }
}

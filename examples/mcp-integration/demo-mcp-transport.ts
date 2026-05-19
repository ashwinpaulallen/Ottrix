import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, MCPToolDefinition, MCPTransport } from 'ottrix/tools';

/**
 * In-memory MCP transport for examples.
 * In production, use stdio/SSE transports to reach a real MCP server process.
 */
export class DemoMcpTransport implements MCPTransport {
  private connected = false;
  private handler?: (message: JsonRpcMessage) => void;

  constructor(private readonly tools: MCPToolDefinition[]) {}

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  request(message: JsonRpcRequest): Promise<JsonRpcMessage> {
    if (!this.connected) {
      throw new Error('DemoMcpTransport is not connected');
    }
    const id = message.id;
    if (id === undefined) {
      throw new Error('JSON-RPC request requires an id');
    }

    let result: unknown;
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'demo-mcp-server', version: '1.0.0' },
        };
        break;
      case 'tools/list':
        result = { tools: this.tools };
        break;
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = params.name ?? '';
        const args = params.arguments ?? {};
        if (name === 'get_time') {
          result = { content: [{ type: 'text', text: new Date().toISOString() }], isError: false };
        } else {
          result = {
            content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
            isError: false,
          };
        }
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

  notify(_message: JsonRpcNotification): Promise<void> {
    return Promise.resolve();
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  onDisconnect(): void {
    // no-op for demo
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): Promise<void> {
    this.connected = false;
    this.handler = undefined;
    return Promise.resolve();
  }
}

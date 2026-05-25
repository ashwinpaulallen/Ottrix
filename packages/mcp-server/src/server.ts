import type { Agent, AgentResult, AgentRunMetadata, JSONSchema, ToolDefinition } from 'ottrix';
import { ConfigurationError, ToolNotFoundError, ToolRegistry } from 'ottrix';

import { isJsonRpcNotification, MCPProtocolError } from './json-rpc.js';
import { normalizeMcpInputSchema } from './schema.js';
import { McpSseServerTransport, type McpSseServerTransportOptions } from './transports/sse.js';
import { McpStdioServerTransport, type McpStdioServerTransportOptions } from './transports/stdio.js';
import type {
  MCPServerMessageHandler,
  MCPServerReplyFn,
  MCPServerSession,
  MCPServerTransport,
} from './transports/types.js';
import { MCP_PROTOCOL_VERSION } from './types.js';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  MCPToolCallResult,
  MCPToolDefinition,
} from './types.js';

/** Meta-tool exposed when an {@link Agent} is configured on the server. */
export const ASK_AGENT_TOOL_NAME = 'ask_agent';

const ASK_AGENT_INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Message to send to the agent' },
  },
  required: ['message'],
};

/** Configuration for {@link MCPServer}. */
export interface MCPServerOptions {
  name: string;
  version: string;
  toolRegistry: ToolRegistry;
  transport: 'stdio' | 'sse';
  port?: number;
  host?: string;
  agent?: Agent;
  transportImpl?: MCPServerTransport;
  stdio?: McpStdioServerTransportOptions;
  sse?: McpSseServerTransportOptions;
}

export type MCPServerConnectionCallback = (session: MCPServerSession) => void;
export type MCPServerErrorCallback = (error: Error, session?: MCPServerSession) => void;

/** MCP server exposing ottrix tools to external MCP clients over stdio or HTTP+SSE. */
export class MCPServer {
  private readonly name: string;
  private readonly version: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly agent?: Agent;
  private readonly transportImpl: MCPServerTransport;

  private running = false;
  private readonly connectionListeners = new Set<MCPServerConnectionCallback>();
  private readonly errorListeners = new Set<MCPServerErrorCallback>();
  private readonly notifiedSessions = new Set<string>();

  constructor(options: MCPServerOptions) {
    this.name = options.name;
    this.version = options.version;
    this.toolRegistry = options.toolRegistry;
    this.agent = options.agent;

    if (options.transportImpl) {
      this.transportImpl = options.transportImpl;
    } else if (options.transport === 'sse') {
      this.transportImpl = new McpSseServerTransport({
        port: options.port,
        host: options.host,
        ...options.sse,
      });
    } else {
      this.transportImpl = new McpStdioServerTransport(options.stdio);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getTransport(): MCPServerTransport {
    return this.transportImpl;
  }

  getBaseUrl(): string | undefined {
    return this.transportImpl instanceof McpSseServerTransport
      ? this.transportImpl.getBaseUrl()
      : undefined;
  }

  getConnectedClients(): number {
    return this.transportImpl.getConnectedClients();
  }

  onConnection(callback: MCPServerConnectionCallback): () => void {
    this.connectionListeners.add(callback);
    return () => this.connectionListeners.delete(callback);
  }

  onError(callback: MCPServerErrorCallback): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    const handler: MCPServerMessageHandler = (message, reply, session) =>
      this.handleMessage(message, reply, session);

    await this.transportImpl.start(handler, {
      onSessionConnect: (session) => {
        if (this.notifiedSessions.has(session.id)) {
          return;
        }
        this.notifiedSessions.add(session.id);
        this.emitConnection(session);
      },
    });
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.transportImpl.stop();
    this.running = false;
    this.notifiedSessions.clear();
  }

  private emitConnection(session: MCPServerSession): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(session);
      } catch {
        // Listener errors must not break the server loop.
      }
    }
  }

  private emitError(error: Error, session?: MCPServerSession): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error, session);
      } catch {
        // Same: never throw out of dispatch.
      }
    }
  }

  private async handleMessage(
    message: JsonRpcRequest | JsonRpcNotification,
    reply: MCPServerReplyFn,
    session: MCPServerSession,
  ): Promise<void> {
    if (isJsonRpcNotification(message)) {
      await this.handleNotification(message, session);
      return;
    }

    const request = message as JsonRpcRequest;
    if (request.id === undefined) {
      reply(jsonRpcError(0, -32600, 'Invalid Request'));
      return;
    }

    if (this.requiresInitialized(request.method) && !session.initialized) {
      reply(jsonRpcError(request.id, -32002, 'Client not initialized'));
      return;
    }

    try {
      switch (request.method) {
        case 'initialize':
          reply(this.handleInitialize(request));
          return;
        case 'tools/list':
          reply(this.handleToolsList(request));
          return;
        case 'tools/call':
          reply(await this.handleToolsCall(request));
          return;
        default:
          reply(jsonRpcError(request.id, -32601, `Method not found: ${request.method}`));
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.emitError(normalized, session);
      reply(jsonRpcError(request.id, -32603, normalized.message));
    }
  }

  private handleNotification(
    notification: JsonRpcNotification,
    session: MCPServerSession,
  ): Promise<void> {
    if (notification.method === 'notifications/initialized') {
      session.initialized = true;
      return Promise.resolve();
    }
    this.emitError(
      new MCPProtocolError(`Unknown notification: ${notification.method}`, -32601),
      session,
    );
    return Promise.resolve();
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    return jsonRpcSuccess(request.id!, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: this.name, version: this.version },
    });
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    return jsonRpcSuccess(request.id!, { tools: this.listMcpTools() });
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (!name) {
      return jsonRpcSuccess(request.id!, toolErrorResult('Tool name is required'));
    }

    if (name === ASK_AGENT_TOOL_NAME) {
      if (!this.agent) {
        return jsonRpcSuccess(request.id!, toolErrorResult(`Tool not found: ${name}`));
      }
      return jsonRpcSuccess(request.id!, await this.executeAskAgent(args));
    }

    try {
      const result = await this.toolRegistry.execute(name, args);
      if (!result.success) {
        return jsonRpcSuccess(
          request.id!,
          toolErrorResult(result.error ?? 'Tool execution failed', result),
        );
      }
      return jsonRpcSuccess(request.id!, toolSuccessResult(result));
    } catch (error) {
      if (error instanceof ToolNotFoundError || ConfigurationError.isConfigurationError(error)) {
        return jsonRpcSuccess(request.id!, toolErrorResult(error.message));
      }
      throw error;
    }
  }

  private requiresInitialized(method: string): boolean {
    return method === 'tools/list' || method === 'tools/call';
  }

  private listMcpTools(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = this.toolRegistry.list().map(toMcpToolDefinition);
    if (this.agent) {
      tools.push({
        name: ASK_AGENT_TOOL_NAME,
        description: 'Send a message to the agent',
        inputSchema: ASK_AGENT_INPUT_SCHEMA,
      });
    }
    return tools;
  }

  private async executeAskAgent(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const message = typeof args.message === 'string' ? args.message : '';
    if (!message) {
      return toolErrorResult('message is required');
    }

    try {
      const result: AgentResult<AgentRunMetadata> = await this.agent!.run(message);
      return toolSuccessResult({
        success: true,
        output: {
          response: result.response,
          metadata: result.metadata,
          totalTokens: result.totalTokens,
        },
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      return toolErrorResult(normalized.message);
    }
  }
}

function toMcpToolDefinition(tool: ToolDefinition): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeMcpInputSchema(tool.inputSchema),
  };
}

function jsonRpcSuccess(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

function toolSuccessResult(output: unknown): MCPToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    isError: false,
  };
}

function toolErrorResult(message: string, output?: unknown): MCPToolCallResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    ...(output !== undefined ? { output } : {}),
  };
}

export { McpStdioServerTransport, McpSseServerTransport };

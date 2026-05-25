import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { parseInboundJsonRpcMessage } from '../json-rpc.js';
import type { JsonRpcResponse } from '../types.js';
import type {
  MCPServerMessageHandler,
  MCPServerSession,
  MCPServerTransport,
} from './types.js';

/** Options for {@link McpSseServerTransport}. */
export interface McpSseServerTransportOptions {
  port?: number;
  host?: string;
  ssePath?: string;
  messagePath?: string;
  keepaliveMs?: number;
  maxBodyBytes?: number;
}

interface SseClient {
  id: string;
  response: ServerResponse;
  session: MCPServerSession;
  keepaliveTimer: ReturnType<typeof setInterval>;
}

const DEFAULT_PORT = 3001;
const DEFAULT_KEEPALIVE_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * MCP server HTTP+SSE transport (protocol 2024-11-05).
 *
 * - `GET /sse` opens an SSE stream and receives an `endpoint` event.
 * - `POST /message?sessionId=…` accepts client JSON-RPC requests.
 * - Responses are delivered on the client's SSE stream as `message` events.
 */
export class McpSseServerTransport implements MCPServerTransport {
  private readonly port: number;
  private readonly host: string;
  private readonly ssePath: string;
  private readonly messagePath: string;
  private readonly keepaliveMs: number;
  private readonly maxBodyBytes: number;

  private handler?: MCPServerMessageHandler;
  private onSessionConnect?: (session: MCPServerSession) => void;
  private server?: Server;
  private readonly clients = new Map<string, SseClient>();

  constructor(options: McpSseServerTransportOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? '127.0.0.1';
    this.ssePath = options.ssePath ?? '/sse';
    this.messagePath = options.messagePath ?? '/message';
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  getBaseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(
    handler: MCPServerMessageHandler,
    options?: { onSessionConnect?: (session: MCPServerSession) => void },
  ): Promise<void> {
    if (this.server) {
      return;
    }
    this.handler = handler;
    this.onSessionConnect = options?.onSessionConnect;

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) {
      clearInterval(client.keepaliveTimer);
      client.response.end();
    }
    this.clients.clear();

    const server = this.server;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.server = undefined;
    this.handler = undefined;
    this.onSessionConnect = undefined;
  }

  getConnectedClients(): number {
    return this.clients.size;
  }

  sendToClient(sessionId: string, response: JsonRpcResponse): void {
    const client = this.clients.get(sessionId);
    if (!client) {
      return;
    }
    this.writeSseEvent(client.response, 'message', JSON.stringify(response));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', this.getBaseUrl());

    if (req.method === 'GET' && url.pathname === this.ssePath) {
      this.handleSseConnect(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === this.messagePath) {
      await this.handleMessagePost(req, res, url);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleSseConnect(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = randomUUID();
    const session: MCPServerSession = { id: sessionId, initialized: false };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const keepaliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, this.keepaliveMs);

    const client: SseClient = { id: sessionId, response: res, session, keepaliveTimer };
    this.clients.set(sessionId, client);

    res.on('close', () => {
      clearInterval(keepaliveTimer);
      this.clients.delete(sessionId);
    });

    const host = req.headers.host ?? `${this.host}:${this.port}`;
    const endpoint = `http://${host}${this.messagePath}?sessionId=${encodeURIComponent(sessionId)}`;
    this.writeSseEvent(res, 'endpoint', endpoint);
    this.onSessionConnect?.(session);
  }

  private async handleMessagePost(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const client = this.clients.get(sessionId);
    if (!client) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Unknown session');
      return;
    }

    const body = await readRequestBody(req, this.maxBodyBytes);
    let message;
    try {
      message = parseInboundJsonRpcMessage(body);
    } catch (error) {
      const isTooLarge = error instanceof Error && error.message === 'Request body too large';
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: isTooLarge ? -32600 : -32700,
          message: isTooLarge ? 'Request body too large' : 'Parse error',
        },
      };
      this.sendToClient(sessionId, errorResponse);
      res.writeHead(isTooLarge ? 413 : 202);
      res.end();
      return;
    }

    const handler = this.handler;
    if (!handler) {
      res.writeHead(503);
      res.end('Server not ready');
      return;
    }

    if ('method' in message) {
      await handler(
        message,
        (response) => this.sendToClient(sessionId, response),
        client.session,
      );
      res.writeHead(202);
      res.end();
      return;
    }

    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Expected JSON-RPC request');
  }

  private writeSseEvent(res: ServerResponse, event: string, data: string): void {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  MCPToolCallResult,
  MCPToolContentBlock,
} from './types.js';

/**
 * Stateful generator of monotonically increasing JSON-RPC request ids.
 *
 * Use one instance per transport/client to avoid cross-client id collisions.
 */
export class RequestIdGenerator {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  /** Return the next id and advance the counter. */
  generate(): number {
    return this.next++;
  }

  /** Reset the counter (used by tests). */
  reset(value = 1): void {
    this.next = value;
  }
}

/** Type guard for JSON-RPC responses. */
export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && message.id !== undefined && !('method' in message);
}

/** Type guard for JSON-RPC notifications. */
export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message && message.id !== undefined);
}

/** Build a JSON-RPC request object. */
export function buildRequest(
  method: string,
  params: unknown,
  id: number | string,
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

/** Build a JSON-RPC notification object. */
export function buildNotification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/** JSON-RPC / MCP protocol error (e.g. transport-level failures). */
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

/** Serialize a JSON-RPC message to a single line (stdio transport). */
export function serializeMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parse a newline-delimited JSON-RPC message (stdio transport). */
export function parseMessageLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  return parseJsonRpcMessage(trimmed);
}

/** Parse JSON text into a JSON-RPC message. */
export function parseJsonRpcMessage(text: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new MCPProtocolError('Invalid JSON-RPC message: not an object', -32700);
  }
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') {
    throw new MCPProtocolError('Invalid JSON-RPC message: missing jsonrpc 2.0', -32600);
  }
  const message = parsed as JsonRpcMessage;
  if (isJsonRpcNotification(message)) {
    return message;
  }
  if (isJsonRpcResponse(message)) {
    return message;
  }
  throw new MCPProtocolError('Invalid JSON-RPC message: unrecognized shape', -32600);
}

/** Throw if the JSON-RPC response contains an error. */
export function assertJsonRpcSuccess<T>(response: JsonRpcResponse): T {
  if (response.error) {
    const err = response.error;
    throw new MCPProtocolError(err.message, err.code, err.data);
  }
  return response.result as T;
}

/**
 * Thrown when a tool returns a result with `isError: true`.
 *
 * Carries the full {@link MCPToolCallResult} so callers can inspect content
 * blocks, codes, and any extra fields that the server returned.
 */
export class MCPToolError extends Error {
  /** Original tool result payload from the server. */
  readonly result: MCPToolCallResult;
  /** Content blocks reported by the tool (may be empty). */
  readonly content: MCPToolContentBlock[];

  constructor(result: MCPToolCallResult) {
    super(extractToolErrorMessage(result));
    this.name = 'MCPToolError';
    this.result = result;
    this.content = result.content ?? [];
  }
}

/**
 * Validate and return the structured `tools/call` result.
 *
 * Returns the raw {@link MCPToolCallResult} unchanged on success. On
 * `isError: true`, throws {@link MCPToolError} so callers can distinguish
 * tool-level failures from transport-level {@link MCPProtocolError}s.
 *
 * Use {@link extractTextContent} when you want a flattened text summary.
 */
export function normalizeToolCallResult(result: unknown): MCPToolCallResult {
  const wrapped = coerceToolCallResult(result);

  if (wrapped.isError === true) {
    throw new MCPToolError(wrapped);
  }

  return wrapped;
}

/**
 * Flatten the `content` blocks of an {@link MCPToolCallResult} into a single
 * string by concatenating all `text`-type blocks with newlines.
 *
 * @returns Concatenated text, or `undefined` if no text blocks are present.
 */
export function extractTextContent(result: MCPToolCallResult): string | undefined {
  const content = result.content;
  if (!content || content.length === 0) {
    return undefined;
  }
  const texts = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function coerceToolCallResult(result: unknown): MCPToolCallResult {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as MCPToolCallResult;
  }
  return {
    content: [{ type: 'text', text: result === undefined ? '' : JSON.stringify(result) }],
  };
}

function extractToolErrorMessage(result: MCPToolCallResult): string {
  const text = extractTextContent(result);
  return text ?? 'MCP tool returned an error';
}

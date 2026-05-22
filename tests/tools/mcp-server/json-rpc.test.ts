import { describe, expect, it } from 'vitest';
import { parseInboundJsonRpcMessage } from '../../../src/tools/mcp/json-rpc.js';

describe('parseInboundJsonRpcMessage', () => {
  it('parses JSON-RPC requests with method and id', () => {
    const message = parseInboundJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    );
    expect(message).toMatchObject({ id: 1, method: 'tools/list' });
  });

  it('parses JSON-RPC notifications without id', () => {
    const message = parseInboundJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(message).toMatchObject({ method: 'notifications/initialized' });
    expect('id' in message).toBe(false);
  });
});

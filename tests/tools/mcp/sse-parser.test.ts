import { describe, expect, it } from 'vitest';
import { SseParser } from '../../../src/tools/mcp/sse-parser.js';

describe('SseParser', () => {
  it('parses endpoint and message events', () => {
    const parser = new SseParser();
    const chunk =
      'event: endpoint\n' +
      'data: http://localhost:3000/messages\n\n' +
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';

    const events = parser.feed(chunk);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      event: 'endpoint',
      data: 'http://localhost:3000/messages',
    });
    expect(events[1]?.event).toBe('message');
    expect(events[1]?.data).toContain('"jsonrpc"');
  });

  it('handles multiline data fields', () => {
    const parser = new SseParser();
    const events = parser.feed('event: message\ndata: line1\ndata: line2\n\n');
    expect(events[0]?.data).toBe('line1\nline2');
  });
});

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../src/types/agent.js';
import {
  SSE_HEADERS,
  agentEventToSse,
  formatSseComment,
  formatSseEvent,
} from '../../src/http/sse.js';

describe('formatSseEvent', () => {
  it('produces correct wire format with id', () => {
    const wire = formatSseEvent({
      event: 'text',
      data: JSON.stringify({ text: 'hello' }),
      id: '0',
    });

    expect(wire).toBe('event: text\ndata: {"text":"hello"}\nid: 0\n\n');
  });

  it('omits id line when id is undefined', () => {
    const wire = formatSseEvent({
      event: 'error',
      data: JSON.stringify({ message: 'fail' }),
    });

    expect(wire).toBe('event: error\ndata: {"message":"fail"}\n\n');
  });
});

describe('formatSseComment', () => {
  it('produces correct comment format', () => {
    expect(formatSseComment('keepalive')).toBe(': keepalive\n\n');
  });
});

describe('agentEventToSse', () => {
  it('maps all agent event types with ordered ids', () => {
    const events: AgentEvent[] = [
      { type: 'text', data: { text: 'hi' } },
      { type: 'tool_call', data: { name: 'lookup', input: { q: 'x' }, id: 't1' } },
      { type: 'tool_result', data: { id: 't1', success: true, output: 'ok' } },
      { type: 'done', data: { stopReason: 'completed', response: 'done' } },
    ];

    expect(agentEventToSse(events[0]!, 0)).toEqual({
      event: 'text',
      data: JSON.stringify({ text: 'hi' }),
      id: '0',
    });
    expect(agentEventToSse(events[1]!, 1)).toEqual({
      event: 'tool_call',
      data: JSON.stringify(events[1]!.data),
      id: '1',
    });
    expect(agentEventToSse(events[2]!, 2)).toEqual({
      event: 'tool_result',
      data: JSON.stringify(events[2]!.data),
      id: '2',
    });
    expect(agentEventToSse(events[3]!, 3)).toEqual({
      event: 'done',
      data: JSON.stringify(events[3]!.data),
      id: '3',
    });
  });
});

describe('SSE_HEADERS', () => {
  it('includes all required headers', () => {
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream');
    expect(SSE_HEADERS['Cache-Control']).toBe('no-cache, no-transform');
    expect(SSE_HEADERS.Connection).toBe('keep-alive');
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });
});

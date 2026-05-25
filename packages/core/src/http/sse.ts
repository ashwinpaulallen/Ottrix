import type { AgentEvent } from '../types/agent.js';

/** Server-sent event payload for agent streaming. */
export interface SseEvent {
  /** Event name (`text`, `tool_call`, `tool_result`, `done`, `error`). */
  event: string;
  /** JSON-stringified event payload. */
  data: string;
  /** Optional event ID for client reconnection. */
  id?: string;
}

/** Format an {@link SseEvent} as SSE wire text. */
export function formatSseEvent(event: SseEvent): string {
  let lines = `event: ${event.event}\ndata: ${event.data}`;
  if (event.id !== undefined) {
    lines += `\nid: ${event.id}`;
  }
  return `${lines}\n\n`;
}

/** Format an SSE comment (keepalive). */
export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/** Map an ottrix {@link AgentEvent} to an {@link SseEvent}. */
export function agentEventToSse(agentEvent: AgentEvent, index: number): SseEvent {
  const id = String(index);

  switch (agentEvent.type) {
    case 'text':
      return {
        event: 'text',
        data: JSON.stringify({ text: (agentEvent.data as { text: string }).text }),
        id,
      };
    case 'tool_call':
      return {
        event: 'tool_call',
        data: JSON.stringify(agentEvent.data),
        id,
      };
    case 'tool_result':
      return {
        event: 'tool_result',
        data: JSON.stringify(agentEvent.data),
        id,
      };
    case 'done':
      return {
        event: 'done',
        data: JSON.stringify(agentEvent.data),
        id,
      };
    default:
      return {
        event: agentEvent.type,
        data: JSON.stringify(agentEvent.data),
        id,
      };
  }
}

/** Standard response headers for SSE streams. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/** Recommended keepalive interval for SSE connections (ms). */
export const KEEPALIVE_INTERVAL_MS = 15_000;

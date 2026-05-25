import type { Request, Response } from 'express';
import type { Agent, AgentEvent } from 'ottrix';

const DEFAULT_KEEPALIVE_MS = 15_000;

/** Sets standard Server-Sent Events response headers. */
export function setSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

/** Writes a single agent event in SSE wire format. */
export function writeSseEvent(res: Response, event: AgentEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * Streams {@link Agent.stream} events to an Express response as SSE.
 * Stops iteration when the client disconnects (`req` or `res` `close` event).
 */
export function sendAgentStream(
  agent: Agent,
  message: string,
  res: Response,
  req?: Request,
  keepaliveMs = DEFAULT_KEEPALIVE_MS,
): void {
  setSseHeaders(res);

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req?.on('close', onClose);
  res.on('close', onClose);

  const keepaliveTimer = setInterval(() => {
    if (!closed) {
      res.write(': keepalive\n\n');
    }
  }, keepaliveMs);
  keepaliveTimer.unref?.();

  void (async () => {
    try {
      for await (const event of agent.stream(message)) {
        if (closed) {
          break;
        }
        writeSseEvent(res, event);
        if (event.type === 'done') {
          break;
        }
      }
    } finally {
      clearInterval(keepaliveTimer);
      req?.off('close', onClose);
      res.off('close', onClose);
      if (!closed) {
        res.end();
      }
    }
  })();
}

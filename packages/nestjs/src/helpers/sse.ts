import { Observable } from 'rxjs';
import type { Agent } from 'ottrix';
import {
  agentEventToSse,
  KEEPALIVE_INTERVAL_MS,
} from 'ottrix/http';

/** NestJS SSE {@link MessageEvent} shape. */
export interface SseMessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

/** Options for {@link createSseStream}. */
export interface CreateSseStreamOptions {
  /** Optional abort signal from the HTTP request (client disconnect). */
  signal?: AbortSignal;
}

/**
 * Bridge {@link Agent.stream} to NestJS `@Sse()` as an `Observable<MessageEvent>`.
 *
 * @example
 * ```ts
 * @Sse('stream')
 * stream(@Query('message') message: string) {
 *   return createSseStream(this.agent)(message);
 * }
 * ```
 */
export function createSseStream(
  agent: Agent,
  options: CreateSseStreamOptions = {},
): (message: string) => Observable<SseMessageEvent> {
  return (message: string) =>
    new Observable<SseMessageEvent>((subscriber) => {
      const abortController = new AbortController();
      const signal = mergeAbortSignals(options.signal, abortController.signal);
      let closed = false;

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearTimeout(firstKeepaliveTimer);
        clearInterval(keepaliveTimer);
        abortController.abort();
      };

      if (signal.aborted) {
        subscriber.complete();
        return cleanup;
      }

      signal.addEventListener('abort', () => {
        cleanup();
        subscriber.complete();
      });

      const firstKeepaliveMs = Math.min(100, KEEPALIVE_INTERVAL_MS);
      const firstKeepaliveTimer = setTimeout(() => {
        if (!closed) {
          subscriber.next({ data: ': keepalive' });
        }
      }, firstKeepaliveMs);
      firstKeepaliveTimer.unref?.();

      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          subscriber.next({ data: ': keepalive' });
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer.unref?.();

      void (async () => {
        try {
          let index = 0;
          for await (const event of agent.stream(message)) {
            if (closed || signal.aborted) {
              break;
            }
            const sse = agentEventToSse(event, index);
            subscriber.next({ type: sse.event, data: sse.data, id: sse.id });
            index += 1;
            if (event.type === 'done') {
              break;
            }
          }
          if (!closed) {
            subscriber.complete();
          }
        } catch (error) {
          if (!closed) {
            subscriber.error(error);
          }
        } finally {
          cleanup();
        }
      })();

      return cleanup;
    });
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

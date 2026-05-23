import { Observable } from 'rxjs';
import type { Agent } from 'ottrix/agent';
import type { AgentEvent } from 'ottrix/types';

/** NestJS SSE {@link MessageEvent} shape. */
export interface SseMessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

/** Options for {@link createSseHandler}. */
export interface SseHandlerOptions {
  /** Keepalive interval in milliseconds. @defaultValue 15000 */
  keepaliveMs?: number;
  /** Optional abort signal from the HTTP request (client disconnect). */
  signal?: AbortSignal;
}

/**
 * Create an SSE handler compatible with NestJS `@Sse()` decorators.
 *
 * @example
 * ```ts
 * @Sse('stream')
 * stream(@Query('message') message: string, @Req() req: Request) {
 *   return createSseHandler(this.researcher, { signal: req.signal })(message);
 * }
 * ```
 */
export function createSseHandler(
  agent: Agent,
  options: SseHandlerOptions = {},
): (input: string, signal?: AbortSignal) => Observable<SseMessageEvent> {
  const keepaliveMs = options.keepaliveMs ?? 15_000;

  return (input: string, signal?: AbortSignal) =>
    new Observable<SseMessageEvent>((subscriber) => {
      const abortController = new AbortController();
      const combinedSignal = mergeAbortSignals(options.signal, signal, abortController.signal);
      let closed = false;
      let clearKeepalive = (): void => {};

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearKeepalive();
        abortController.abort();
      };

      if (combinedSignal.aborted) {
        subscriber.complete();
        return cleanup;
      }

      combinedSignal.addEventListener('abort', () => {
        cleanup();
        subscriber.complete();
      });

      const keepaliveTimer = setInterval(() => {
        subscriber.next({ data: ': keepalive\n\n', type: 'keepalive' });
      }, keepaliveMs);
      keepaliveTimer.unref?.();
      clearKeepalive = (): void => {
        clearInterval(keepaliveTimer);
      };

      void (async () => {
        try {
          for await (const event of agent.stream(input)) {
            if (closed || combinedSignal.aborted) {
              break;
            }
            subscriber.next(toMessageEvent(event));
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

function toMessageEvent(event: AgentEvent): SseMessageEvent {
  return {
    type: event.type,
    data: {
      type: event.type,
      data: event.data,
    },
  };
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

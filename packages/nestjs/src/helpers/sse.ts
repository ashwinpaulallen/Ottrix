import { Observable } from 'rxjs';
import type { Agent } from 'ottrix';
import type { AgentEvent } from 'ottrix';

/** NestJS SSE {@link MessageEvent} shape. */
export interface SseMessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

/** Options for {@link createSseStream}. */
export interface CreateSseStreamOptions {
  /** Keepalive interval in milliseconds. @defaultValue 15000 */
  keepaliveMs?: number;
  /** Optional abort signal from the HTTP request (client disconnect). */
  signal?: AbortSignal;
}

/**
 * Bridge {@link Agent.stream} to NestJS `@Sse()` as an `Observable<MessageEvent>`.
 */
export function createSseStream(
  agent: Agent,
  message: string,
  options: CreateSseStreamOptions = {},
): Observable<SseMessageEvent> {
  const keepaliveMs = options.keepaliveMs ?? 15_000;

  return new Observable<SseMessageEvent>((subscriber) => {
    const abortController = new AbortController();
    const signal = mergeAbortSignals(options.signal, abortController.signal);
    let closed = false;

    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
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

    const keepaliveTimer = setInterval(() => {
      subscriber.next({ data: ': keepalive\n\n', type: 'keepalive' });
    }, keepaliveMs);
    keepaliveTimer.unref?.();

    void (async () => {
      try {
        for await (const event of agent.stream(message)) {
          if (closed || signal.aborted) {
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

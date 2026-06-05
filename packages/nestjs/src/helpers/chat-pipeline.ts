import { Observable } from 'rxjs';
import type { Agent, TokenUsage } from 'ottrix';
import { KEEPALIVE_INTERVAL_MS } from 'ottrix/http';
import type { SessionMemoryService } from '../session/session-memory.js';
import { createSseStream, type SseMessageEvent } from './sse.js';

/** Context passed to chat pipeline hooks. */
export interface ChatPipelineContext {
  message: string;
  sessionId?: string;
  agent: Agent;
  intent?: string;
}

/** Result passed to {@link ChatPipelineHooks.onComplete}. */
export interface ChatPipelineResult {
  text: string;
  usage?: TokenUsage;
  sessionId?: string;
}

/** Lifecycle hooks for {@link createChatPipeline}. */
export interface ChatPipelineHooks {
  onRouted?: (ctx: ChatPipelineContext) => void | Promise<void>;
  onTextDelta?: (text: string, ctx: ChatPipelineContext) => void;
  onComplete?: (result: ChatPipelineResult) => void | Promise<void>;
  onError?: (error: unknown, ctx: ChatPipelineContext) => void;
}

/** Options for {@link createChatPipeline}. */
export interface ChatPipelineOptions {
  /** Resolve the agent (and optional routing intent) for an incoming message. */
  resolveAgent: (message: string, sessionId?: string) => Agent | Promise<Agent>;
  /** Optional routing label surfaced in hooks (e.g. `'loyalty'`). */
  resolveIntent?: (message: string, sessionId?: string) => string | undefined | Promise<string | undefined>;
  /**
   * Build the prompt sent to the agent.
   * When {@link SessionMemoryService} is set, session history is prepended automatically.
   */
  buildPrompt?: (
    message: string,
    ctx: { sessionId?: string; intent?: string },
  ) => string | Promise<string>;
  /** Session memory — enables history-aware prompts and post-stream recording. */
  sessionMemory?: SessionMemoryService;
  hooks?: ChatPipelineHooks;
  signal?: AbortSignal;
}

/**
 * Higher-level SSE chat pipeline with routing, session memory, and lifecycle hooks.
 *
 * @example
 * ```ts
 * @Sse('stream')
 * stream(@Query('message') message: string, @Headers('x-session-id') sessionId?: string) {
 *   return this.pipeline(message, sessionId);
 * }
 * ```
 */
export function createChatPipeline(
  options: ChatPipelineOptions,
): (message: string, sessionId?: string) => Observable<SseMessageEvent> {
  return (message: string, sessionId?: string) =>
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
        let ctx: ChatPipelineContext | undefined;
        try {
          const [agent, intent] = await Promise.all([
            options.resolveAgent(message, sessionId),
            options.resolveIntent?.(message, sessionId),
          ]);

          ctx = { message, sessionId, agent, intent };
          await options.hooks?.onRouted?.(ctx);

          const prompt = await buildPipelinePrompt(message, sessionId, intent, options);
          const stream = createSseStream(agent, { signal })(prompt);

          let accumulatedText = '';
          let usage: TokenUsage | undefined;

          const subscription = stream.subscribe({
            next: (event) => {
              subscriber.next(event);
              const parsed = parseStreamPayload(event);
              if (parsed.textDelta) {
                accumulatedText += parsed.textDelta;
                options.hooks?.onTextDelta?.(parsed.textDelta, ctx!);
              }
              if (parsed.usage) {
                usage = parsed.usage;
              }
            },
            error: (error) => {
              options.hooks?.onError?.(error, ctx!);
              if (!closed) {
                subscriber.error(error);
              }
              cleanup();
            },
            complete: () => {
              void (async () => {
                if (options.sessionMemory && sessionId && accumulatedText) {
                  await options.sessionMemory.recordTurn(sessionId, message, accumulatedText);
                }
                await options.hooks?.onComplete?.({
                  text: accumulatedText,
                  usage,
                  sessionId,
                });
                if (!closed) {
                  subscriber.complete();
                }
                cleanup();
              })();
            },
          });

          return () => {
            subscription.unsubscribe();
            cleanup();
          };
        } catch (error) {
          if (ctx) {
            options.hooks?.onError?.(error, ctx);
          }
          if (!closed) {
            subscriber.error(error);
          }
          cleanup();
        }
      })();

      return cleanup;
    });
}

async function buildPipelinePrompt(
  message: string,
  sessionId: string | undefined,
  intent: string | undefined,
  options: ChatPipelineOptions,
): Promise<string> {
  if (options.buildPrompt) {
    return options.buildPrompt(message, { sessionId, intent });
  }

  if (options.sessionMemory && sessionId) {
    const memory = await options.sessionMemory.getOrCreate(sessionId);
    const history = memory
      .getMessages()
      .map((entry) => `${entry.role}: ${messageContentToText(entry.content)}`)
      .join('\n');
    if (history) {
      return `Conversation history:\n${history}\n\nUser: ${message}`;
    }
  }

  return message;
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block !== null && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return String(content);
}

function parseStreamPayload(event: SseMessageEvent): {
  textDelta?: string;
  usage?: TokenUsage;
} {
  if (event.type !== 'text' && event.type !== 'done') {
    return {};
  }

  const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  try {
    const parsed = JSON.parse(raw) as { text?: string; usage?: TokenUsage; totalTokens?: TokenUsage };
    if (event.type === 'text' && parsed.text) {
      return { textDelta: parsed.text };
    }
    if (event.type === 'done') {
      const usage = parsed.usage ?? parsed.totalTokens;
      return usage ? { usage } : {};
    }
  } catch {
    return {};
  }
  return {};
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

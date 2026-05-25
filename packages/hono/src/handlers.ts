import type { Handler } from 'hono';
import { stream } from 'hono/streaming';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import { runWith } from 'ottrix';
import {
  agentEventToSse,
  checkHealth,
  extractMessage,
  formatSseComment,
  formatSseEvent,
  KEEPALIVE_INTERVAL_MS,
  SSE_HEADERS,
} from 'ottrix/http';
import { readRequestBody } from './helpers.js';
import type { OttrixEnv } from './middleware.js';

/** Options for {@link agentHandler}. */
export interface AgentHandlerOptions {
  bodyField?: string;
}

/** Options for {@link agentStreamHandler}. */
export interface AgentStreamHandlerOptions {
  queryField?: string;
}

/** Options for {@link ottrixHealth}. */
export interface OttrixHealthOptions {
  registry?: ProviderRegistry;
}

/** POST handler — runs {@link Agent.run} and returns JSON. */
export function agentHandler(agent: Agent, options?: AgentHandlerOptions): Handler<OttrixEnv> {
  const bodyField = options?.bodyField ?? 'message';

  return async (c) => {
    const execute = async () => {
      const parsed = extractMessage(await readRequestBody(c), bodyField);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, parsed.status as 400);
      }

      const result = await agent.run(parsed.message);
      return c.json(result);
    };

    const ctx = c.get('ottrixContext');
    if (ctx) {
      return runWith(ctx, execute);
    }
    return execute();
  };
}

/** GET handler — streams {@link Agent.stream} as Server-Sent Events. */
export function agentStreamHandler(
  agent: Agent,
  options?: AgentStreamHandlerOptions,
): Handler {
  const queryField = options?.queryField ?? 'message';

  return (c) => {
    const parsed = extractMessage({ message: c.req.query(queryField) }, 'message');
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status as 400);
    }

    for (const [key, value] of Object.entries(SSE_HEADERS)) {
      c.header(key, value);
    }

    return stream(c, async (streamWriter) => {
      let closed = false;
      const firstKeepaliveMs = Math.min(100, KEEPALIVE_INTERVAL_MS);
      const firstKeepaliveTimer = setTimeout(() => {
        if (!closed) {
          void streamWriter.write(formatSseComment('keepalive'));
        }
      }, firstKeepaliveMs);
      firstKeepaliveTimer.unref?.();

      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          void streamWriter.write(formatSseComment('keepalive'));
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer.unref?.();

      try {
        let index = 0;
        for await (const event of agent.stream(parsed.message)) {
          if (closed) {
            break;
          }
          await streamWriter.write(formatSseEvent(agentEventToSse(event, index)));
          index += 1;
          if (event.type === 'done') {
            break;
          }
        }
      } finally {
        closed = true;
        clearTimeout(firstKeepaliveTimer);
        clearInterval(keepaliveTimer);
      }
    });
  };
}

/** GET handler — provider health check via {@link checkHealth}. */
export function ottrixHealth(options?: OttrixHealthOptions): Handler {
  return async (c) => {
    if (!options?.registry) {
      return c.json(
        {
          error: 'Provider registry is required for health checks',
          code: 'missing_registry',
        },
        503,
      );
    }

    const result = await checkHealth(options.registry);
    return c.json(result);
  };
}

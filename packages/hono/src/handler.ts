import type { Handler } from 'hono';
import { stream } from 'hono/streaming';
import type { Agent, AgentEvent } from 'ottrix';
import { readAgentMessageBody, type OttrixEnv } from './middleware.js';

/** Options for {@link agentHandler}. */
export interface AgentHandlerOptions {
  bodyField?: string;
}

/** Options for {@link agentStreamHandler}. */
export interface AgentStreamHandlerOptions {
  queryField?: string;
}

/** POST handler — runs {@link Agent.run} and returns JSON. */
export function agentHandler(agent: Agent, options?: AgentHandlerOptions): Handler<OttrixEnv> {
  const bodyField = options?.bodyField ?? 'message';

  return async (c) => {
    const { message } = await readAgentMessageBody(c, bodyField);
    if (!message) {
      return c.json({ error: `${bodyField} required` }, 400);
    }

    const result = await agent.run(message);
    return c.json(result);
  };
}

/** GET handler — streams {@link Agent.stream} as Server-Sent Events. */
export function agentStreamHandler(
  agent: Agent,
  options?: AgentStreamHandlerOptions,
): Handler {
  const queryField = options?.queryField ?? 'message';

  return (c) => {
    const message = c.req.query(queryField);
    if (!message) {
      return c.json({ error: `${queryField} query parameter required` }, 400);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return stream(c, async (streamWriter) => {
      for await (const event of agent.stream(message)) {
        await streamWriter.write(formatSseEvent(event));
        if (event.type === 'done') {
          break;
        }
      }
    });
  };
}

function formatSseEvent(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

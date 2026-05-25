import type { Agent } from 'ottrix';
import type { RunContext } from 'ottrix';
import { PromptInjectionGuardrail, runWith } from 'ottrix';
import {
  buildRunContext,
  corsHeaders,
  extractMessage,
  mapOttrixError,
  scanMessageForInjection,
} from 'ottrix/http';
import type { AgentHandlerOptions } from './handlers.js';
import {
  extractLastUserMessage,
  isRunContextSupported,
  jsonResponse,
  mergeHeaders,
  readJsonBody,
  readRequestHeaders,
} from './helpers.js';

const AI_DATA_STREAM_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'X-Vercel-AI-Data-Stream': 'v1',
} as const;

function formatDataStreamPart(code: string, value: unknown): string {
  if (code === '0' && typeof value === 'string') {
    return `0:${JSON.stringify(value)}\n`;
  }
  return `${code}:${JSON.stringify(value)}\n`;
}

function agentEventToDataStream(event: {
  type: string;
  data: unknown;
}): string | null {
  switch (event.type) {
    case 'text': {
      const text = (event.data as { text?: string }).text ?? '';
      return text.length > 0 ? formatDataStreamPart('0', text) : null;
    }
    case 'tool_call': {
      const data = event.data as { id?: string; name?: string; input?: unknown };
      return formatDataStreamPart('9', {
        toolCallId: data.id,
        toolName: data.name,
        args: JSON.stringify(data.input ?? {}),
      });
    }
    case 'tool_result': {
      const data = event.data as { id?: string; output?: unknown; success?: boolean };
      return formatDataStreamPart('a', {
        toolCallId: data.id,
        result: data.output,
        success: data.success,
      });
    }
    case 'done':
      return formatDataStreamPart('d', { finishReason: 'stop' });
    default:
      return null;
  }
}

/**
 * Stream ottrix agent events in the Vercel AI SDK data-stream wire format.
 * Compatible with `useChat` when the client uses the data stream protocol.
 */
export function createAIStreamResponse(
  agent: Agent,
  message: string,
  options?: { runContext?: RunContext; cors?: Record<string, string> },
): Response {
  const headers = mergeHeaders({ ...AI_DATA_STREAM_HEADERS }, options?.cors ?? {});
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  void (async () => {
    try {
      const streamAgent = async () => {
        for await (const event of agent.stream(message)) {
          const chunk = agentEventToDataStream(event);
          if (chunk) {
            await writer.write(encoder.encode(chunk));
          }
          if (event.type === 'done') {
            break;
          }
        }
      };

      if (options?.runContext && isRunContextSupported()) {
        await runWith(options.runContext, streamAgent);
      } else if (isRunContextSupported()) {
        await runWith({ runId: crypto.randomUUID() }, streamAgent);
      } else {
        await streamAgent();
      }
    } catch (error) {
      const mapped = mapOttrixError(error);
      await writer.write(encoder.encode(formatDataStreamPart('3', mapped.body)));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, { headers });
}

/** POST Route Handler for Vercel AI SDK `useChat` clients. */
export function createChatHandler(options: AgentHandlerOptions) {
  const bodyField = options.bodyField ?? 'message';

  return async function POST(request: Request): Promise<Response> {
    const cors =
      options.cors === false
        ? {}
        : corsHeaders(request.headers.get('origin') ?? undefined);

    try {
      const body = await readJsonBody(request);
      const fromMessages = extractLastUserMessage(body);
      const parsed =
        fromMessages !== undefined
          ? ({ ok: true as const, message: fromMessages })
          : extractMessage(body, bodyField);

      if (!parsed.ok) {
        return jsonResponse({ error: parsed.error }, parsed.status, cors);
      }

      if (options.injection !== false) {
        const mode = options.injection ?? 'block';
        const scan = await scanMessageForInjection(parsed.message, {
          mode,
          guardrail: new PromptInjectionGuardrail({ mode }),
        });
        if (!scan.allowed) {
          return jsonResponse(scan.body, scan.status, cors);
        }
      }

      const runContext =
        options.runContext !== false && isRunContextSupported()
          ? buildRunContext(readRequestHeaders(request))
          : undefined;

      return createAIStreamResponse(options.agent, parsed.message, {
        runContext,
        cors,
      });
    } catch (error) {
      const mapped = mapOttrixError(error);
      return jsonResponse(mapped.body, mapped.status, mergeHeaders(cors, mapped.headers ?? {}));
    }
  };
}

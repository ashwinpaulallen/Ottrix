import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import { PromptInjectionGuardrail, runWith } from 'ottrix';
import {
  agentEventToSse,
  buildRunContext,
  checkHealth,
  corsHeaders,
  extractMessage,
  formatSseComment,
  formatSseEvent,
  KEEPALIVE_INTERVAL_MS,
  mapOttrixError,
  scanMessageForInjection,
  SSE_HEADERS,
} from 'ottrix/http';
import {
  isRunContextSupported,
  jsonResponse,
  mergeHeaders,
  readJsonBody,
  readRequestHeaders,
} from './helpers.js';

/** Options shared by Next.js Route Handler factories. */
export interface AgentHandlerOptions {
  agent: Agent;
  /** JSON body field for the user message on POST. @defaultValue `'message'` */
  bodyField?: string;
  /** Prompt injection handling. @defaultValue `'block'` */
  injection?: 'block' | 'flag' | false;
  /** Enable CORS headers and OPTIONS handler. @defaultValue `true` */
  cors?: boolean;
  /** Enable RunContext via AsyncLocalStorage (Node.js runtime only). @defaultValue `true` */
  runContext?: boolean;
  /** Query param for GET streaming. @defaultValue `'message'` */
  queryField?: string;
}

function resolveCors(request: Request, enabled: boolean | undefined): Record<string, string> {
  if (enabled === false) {
    return {};
  }
  return corsHeaders(request.headers.get('origin') ?? undefined);
}

function shouldUseRunContext(enabled: boolean | undefined): boolean {
  return enabled !== false && isRunContextSupported();
}

async function scanInput(
  message: string,
  options: AgentHandlerOptions,
  cors: Record<string, string>,
): Promise<Response | null> {
  if (options.injection === false) {
    return null;
  }

  const mode = options.injection ?? 'block';
  const scan = await scanMessageForInjection(message, {
    mode,
    guardrail: new PromptInjectionGuardrail({ mode }),
  });

  if (!scan.allowed) {
    return jsonResponse(scan.body, scan.status, cors);
  }

  return null;
}

async function withOptionalRunContext<T>(
  request: Request,
  options: AgentHandlerOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!shouldUseRunContext(options.runContext)) {
    return fn();
  }

  const ctx = buildRunContext(readRequestHeaders(request));
  return runWith(ctx, fn);
}

/** POST Route Handler — runs {@link Agent.run} and returns JSON. */
export function createPostHandler(options: AgentHandlerOptions) {
  const bodyField = options.bodyField ?? 'message';

  return async function POST(request: Request): Promise<Response> {
    const cors = resolveCors(request, options.cors);

    try {
      const body = await readJsonBody(request);
      const parsed = extractMessage(body, bodyField);
      if (!parsed.ok) {
        return jsonResponse({ error: parsed.error }, parsed.status, cors);
      }

      const blocked = await scanInput(parsed.message, options, cors);
      if (blocked) {
        return blocked;
      }

      const result = await withOptionalRunContext(request, options, () =>
        options.agent.run(parsed.message),
      );
      return jsonResponse(result, 200, cors);
    } catch (error) {
      const mapped = mapOttrixError(error);
      return jsonResponse(mapped.body, mapped.status, mergeHeaders(cors, mapped.headers ?? {}));
    }
  };
}

/** GET Route Handler — streams {@link Agent.stream} as Server-Sent Events. */
export function createStreamHandler(options: AgentHandlerOptions) {
  const queryField = options.queryField ?? 'message';

  return async function GET(request: Request): Promise<Response> {
    const cors = resolveCors(request, options.cors);
    const url = new URL(request.url);
    const parsed = extractMessage({ [queryField]: url.searchParams.get(queryField) }, queryField);

    if (!parsed.ok) {
      return jsonResponse({ error: parsed.error }, parsed.status, cors);
    }

    const blocked = await scanInput(parsed.message, options, cors);
    if (blocked) {
      return blocked;
    }

    const headers = mergeHeaders({ ...SSE_HEADERS }, cors);
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    void (async () => {
      let closed = false;
      const firstKeepaliveMs = Math.min(100, KEEPALIVE_INTERVAL_MS);
      const firstKeepaliveTimer = setTimeout(() => {
        if (!closed) {
          void writer.write(encoder.encode(formatSseComment('keepalive')));
        }
      }, firstKeepaliveMs);
      firstKeepaliveTimer.unref?.();

      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          void writer.write(encoder.encode(formatSseComment('keepalive')));
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer.unref?.();

      try {
        let index = 0;

        const streamAgent = async () => {
          for await (const event of options.agent.stream(parsed.message)) {
            if (closed) {
              break;
            }
            await writer.write(encoder.encode(formatSseEvent(agentEventToSse(event, index))));
            index += 1;
            if (event.type === 'done') {
              break;
            }
          }
        };

        if (shouldUseRunContext(options.runContext)) {
          const ctx = buildRunContext(readRequestHeaders(request));
          await runWith(ctx, streamAgent);
        } else {
          await streamAgent();
        }
      } catch (error) {
        const mapped = mapOttrixError(error);
        await writer.write(
          encoder.encode(
            formatSseEvent({
              event: 'error',
              data: JSON.stringify(mapped.body),
            }),
          ),
        );
      } finally {
        closed = true;
        clearTimeout(firstKeepaliveTimer);
        clearInterval(keepaliveTimer);
        await writer.close();
      }
    })();

    return new Response(readable, { headers });
  };
}

/** Combined POST, GET (SSE), and OPTIONS handlers for a single route. */
export function createAgentHandlers(options: AgentHandlerOptions) {
  return {
    POST: createPostHandler(options),
    GET: createStreamHandler(options),
    OPTIONS: async (request: Request) =>
      new Response(null, {
        status: 204,
        headers: resolveCors(request, options.cors),
      }),
  };
}

/** GET Route Handler — provider health check via {@link checkHealth}. */
export function createHealthHandler(options?: { registry?: ProviderRegistry }) {
  return async function GET(): Promise<Response> {
    if (!options?.registry) {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    const health = await checkHealth(options.registry);
    const status = health.status === 'unhealthy' ? 503 : 200;
    return Response.json(health, { status });
  };
}

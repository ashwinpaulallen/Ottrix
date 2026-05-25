import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import {
  createAgent,
  getTelemetry,
  PromptInjectionGuardrail,
  runWith,
  shutdownObservability,
  ToolRegistry,
  type CompletionProvider,
  type CreateAgentConfig,
  type ProviderName,
  type ProviderRegistry,
} from 'ottrix';
import {
  buildRunContext,
  extractMessage,
  isStreamInjectionRequest,
  scanMessageForInjection,
  type ContextExtractors,
} from 'ottrix/http';
import { registerOttrixErrorHandler } from './errors.js';
import { readHeaders } from './helpers.js';
import { createProviderRegistry, type OttrixProviderOptions } from './setup/create-provider-registry.js';
import './types.js';

export type { OttrixProviderOptions };

/** Options for {@link ottrixPlugin}. */
export interface OttrixPluginOptions {
  agents?: Record<string, CreateAgentConfig>;
  providers?: OttrixProviderOptions;
  /** Prompt injection handling. @defaultValue `'block'` */
  injection?: 'block' | 'flag' | false;
  /** Enable RunContext per request. @defaultValue `true` */
  runContext?: boolean | Partial<ContextExtractors>;
  /** HTTP telemetry spans. @defaultValue `true` */
  telemetry?: boolean;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const ottrixPluginImpl: FastifyPluginAsync<OttrixPluginOptions> = async (fastify, opts) => {
  const telemetry = getTelemetry();
  const tools = new ToolRegistry({ telemetry });
  const providers = createProviderRegistry(opts.providers, telemetry);
  const agents = new Map<string, ReturnType<typeof createAgent>>();

  for (const [name, config] of Object.entries(opts.agents ?? {})) {
    agents.set(
      name,
      createAgent({
        ...config,
        name,
        provider: resolveAgentProvider(providers, config.provider),
        telemetry,
      }),
    );
  }

  fastify.decorate('ottrix', { agents, providers, tools });

  const runContext = opts.runContext ?? true;
  if (runContext !== false) {
    const extractors = runContext === true ? undefined : runContext;
    fastify.addHook('onRequest', (request, _reply, done) => {
      request.ottrixContext = buildRunContext(readHeaders(request), extractors);
      void runWith(request.ottrixContext, () => done()).catch(done);
    });
  }

  const injection = opts.injection ?? 'block';
  if (injection !== false) {
    const guardrail = new PromptInjectionGuardrail({ mode: injection });
    fastify.addHook('preHandler', async (request, reply) => {
      let message: string | undefined;

      if (MUTATING_METHODS.has(request.method)) {
        const parsed = extractMessage(request.body, 'message');
        if (!parsed.ok) {
          return;
        }
        message = parsed.message;
      } else if (
        isStreamInjectionRequest(
          request.method,
          request.routeOptions?.url ?? request.url.split('?')[0] ?? '',
        )
      ) {
        const query = request.query as Record<string, unknown>;
        const parsed = extractMessage({ message: query.message }, 'message');
        if (!parsed.ok) {
          return;
        }
        message = parsed.message;
      } else {
        return;
      }

      const scan = await scanMessageForInjection(message, { mode: injection, guardrail });
      if (scan.allowed) {
        return;
      }

      reply.code(scan.status).send(scan.body);
    });
  }

  if (opts.telemetry !== false) {
    fastify.addHook('onRequest', (request, _reply, done) => {
      request.ottrixStartTime = Date.now();
      request.ottrixSpan = telemetry.startSpan('http.request', {
        'http.method': request.method,
        'http.route': request.routeOptions?.url ?? request.url,
      });
      done();
    });

    fastify.addHook('onResponse', (request, reply, done) => {
      const span = request.ottrixSpan;
      if (span) {
        span.setAttribute('http.status_code', reply.statusCode);
        span.setAttribute('http.duration_ms', Date.now() - (request.ottrixStartTime ?? Date.now()));
        span.setStatus(reply.statusCode >= 400 ? 'error' : 'ok');
        span.end();
      }
      done();
    });
  }

  registerOttrixErrorHandler(fastify);

  fastify.addHook('onClose', async () => {
    agents.clear();
    await shutdownObservability();
  });
};

/** Fastify plugin — wires Ottrix providers, agents, hooks, and error handling. */
export const ottrixPlugin = fp(ottrixPluginImpl, {
  name: '@ottrix/fastify',
  fastify: '>=4.0.0',
});

function resolveAgentProvider(
  registry: ProviderRegistry,
  provider?: ProviderName | CompletionProvider,
): ProviderName | CompletionProvider | undefined {
  if (provider === undefined) {
    return undefined;
  }
  if (typeof provider === 'string') {
    try {
      return registry.get(provider);
    } catch {
      return provider;
    }
  }
  return provider;
}

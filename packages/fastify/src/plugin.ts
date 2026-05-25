import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import {
  createAgent,
  getTelemetry,
  PromptInjectionGuardrail,
  runWith,
  ToolRegistry,
  type CompletionProvider,
  type CreateAgentConfig,
  type ProviderName,
  type ProviderRegistry,
  type RunContext,
} from 'ottrix';
import { registerOttrixErrorHandler } from './errors.js';
import { createProviderRegistry, type OttrixProviderOptions } from './setup/create-provider-registry.js';
import './types.js';

export type { OttrixProviderOptions };

/** Prompt injection settings for {@link ottrixPlugin}. */
export interface OttrixInjectionOptions {
  mode?: 'block' | 'flag';
  bodyField?: string;
}

/** Run context extractors for {@link ottrixPlugin}. */
export interface OttrixRunContextOptions {
  orgId?: (request: { headers: Record<string, unknown> }) => string | undefined;
  userId?: (request: { headers: Record<string, unknown> }) => string | undefined;
}

/** Options for {@link ottrixPlugin}. */
export interface OttrixPluginOptions {
  agents?: Record<string, CreateAgentConfig>;
  providers?: OttrixProviderOptions;
  injection?: boolean | OttrixInjectionOptions;
  runContext?: boolean | OttrixRunContextOptions;
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

  const runContextOptions =
    opts.runContext === false ? undefined : normalizeRunContextOptions(opts.runContext ?? true);
  if (runContextOptions !== undefined) {
    fastify.addHook('onRequest', (request, reply, done) => {
      const ctx = buildRunContext(request, runContextOptions);
      request.ottrixContext = ctx;

      runWith(ctx, () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          reply.raw.once('finish', finish);
          reply.raw.once('close', finish);

          try {
            done();
          } catch (error) {
            if (!settled) {
              settled = true;
              reject(error);
            }
            done(error as Error);
          }
        }),
      ).catch((error) => done(error as Error));
    });
  }

  const injectionOptions = normalizeInjectionOptions(opts.injection);
  if (injectionOptions) {
    const guardrail = new PromptInjectionGuardrail({ mode: injectionOptions.mode });
    const bodyField = injectionOptions.bodyField ?? 'message';

    fastify.addHook('preHandler', async (request, reply) => {
      if (!MUTATING_METHODS.has(request.method)) {
        return;
      }

      const body = request.body as Record<string, unknown> | undefined;
      const message = body?.[bodyField];
      if (typeof message !== 'string' || message.length === 0) {
        return;
      }

      const detection = await guardrail.checkInput(message);
      if (!detection.detected) {
        return;
      }

      if (injectionOptions.mode === 'flag') {
        return;
      }

      reply.code(403).send({ error: 'Blocked' });
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
        span.setAttribute(
          'http.duration_ms',
          Date.now() - (request.ottrixStartTime ?? Date.now()),
        );
        span.setStatus(reply.statusCode >= 400 ? 'error' : 'ok');
        span.end();
      }
      done();
    });
  }

  registerOttrixErrorHandler(fastify);

  fastify.addHook('onClose', async () => {
    agents.clear();
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

function buildRunContext(
  request: { headers: Record<string, unknown> },
  options?: OttrixRunContextOptions,
): RunContext {
  const runId = readHeader(request.headers, 'x-request-id') ?? randomUUID();
  const orgId = options?.orgId?.(request) ?? readHeader(request.headers, 'x-org-id');
  const userId = options?.userId?.(request) ?? readHeader(request.headers, 'x-user-id');

  return {
    runId,
    ...(orgId ? { orgId } : {}),
    ...(userId ? { userId } : {}),
  } as RunContext;
}

function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function normalizeInjectionOptions(
  injection: OttrixPluginOptions['injection'],
): OttrixInjectionOptions | undefined {
  if (injection === false || injection === undefined) {
    return undefined;
  }
  if (injection === true) {
    return { mode: 'block', bodyField: 'message' };
  }
  return {
    mode: injection.mode ?? 'block',
    bodyField: injection.bodyField ?? 'message',
  };
}

function normalizeRunContextOptions(
  runContext: OttrixPluginOptions['runContext'],
): OttrixRunContextOptions | undefined {
  if (runContext === false || runContext === undefined) {
    return undefined;
  }
  if (runContext === true) {
    return {};
  }
  return runContext;
}

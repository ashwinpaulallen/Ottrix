import type { Agent, ProviderRegistry, RunContext, Telemetry, ToolRegistry } from 'ottrix';

/** Ottrix state attached to a Fastify instance by {@link ottrixPlugin}. */
export interface OttrixFastifyState {
  agents: Map<string, Agent>;
  providers: ProviderRegistry;
  tools: ToolRegistry;
}

declare module 'fastify' {
  interface FastifyInstance {
    ottrix: OttrixFastifyState;
  }

  interface FastifyRequest {
    ottrixContext?: RunContext;
    ottrixSpan?: ReturnType<Telemetry['startSpan']>;
    ottrixStartTime?: number;
  }
}

export type { Agent, ProviderRegistry, RunContext, ToolRegistry };

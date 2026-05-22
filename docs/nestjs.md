# NestJS integration (`@ottrix/nestjs`)

Source: `packages/nestjs/`

First-party NestJS adapter for Ottrix — dependency injection, lifecycle hooks, guards, interceptors, SSE streaming, and health checks.

Full package README: [`packages/nestjs/README.md`](../packages/nestjs/README.md)

## Install

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

Optional peer: `@nestjs/terminus` (health indicator registration).

## `OttrixModule`

| Method | Purpose |
|--------|---------|
| `forRoot(options)` | Global providers, telemetry, guardrails, registries |
| `forRootAsync(options)` | Async config via `ConfigService` or factory |
| `forFeature(options)` | Feature-scoped agents, tools, workflows |

### Core services

| Service | Role |
|---------|------|
| `ProviderRegistryService` | Wraps Ottrix `ProviderRegistry` with fallback chain |
| `ToolRegistryService` | Global `ToolRegistry` + MCP registry lifecycle |
| `TelemetryService` | Configures trace exporters; flushes on destroy |
| `GuardrailService` | Builds `GuardrailMiddleware` per agent |
| `RunContextService` | ALS helpers; `contextFromRequest()` for HTTP |

### Injection tokens

| Token | Resolves to |
|-------|-------------|
| `OTTRIX_TOOL_REGISTRY` | Global `ToolRegistry` |
| `OTTRIX_TELEMETRY` | `TelemetryService` |
| `OTTRIX_PROVIDER_REGISTRY` | `ProviderRegistryService` |
| `OTTRIX_RUN_CONTEXT` | `RunContextService` |
| `OTTRIX_GUARDRAIL_SERVICE` | `GuardrailService` |
| `agentToken('name')` | Named `Agent` from `forFeature` |
| `workflowToken('name')` | Named `DAGWorkflow` from `forFeature` |

### Decorators

- `@InjectAgent('name')` — inject feature agent
- `@InjectWorkflow('name')` — inject feature workflow
- `@InjectProvider('anthropic')` — inject named provider

## Guards and interceptors

Guards and interceptors are **registered as providers** but must be wired globally (or per-controller) by the app:

```ts
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { InjectionGuard, BudgetGuard, TelemetryInterceptor, RunContextInterceptor } from '@ottrix/nestjs';

@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RunContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor },
    { provide: APP_GUARD, useClass: InjectionGuard },
    { provide: APP_GUARD, useClass: BudgetGuard },
  ],
})
export class AppModule {}
```

| Component | Behavior |
|-----------|----------|
| `RunContextInterceptor` | Establishes ALS from `x-run-id`, `x-request-id`, `user.orgId` |
| `TelemetryInterceptor` | Wraps HTTP requests in Ottrix telemetry spans |
| `InjectionGuard` | Scans request body for prompt injection; supports `messages[].content` |
| `BudgetGuard` | Async org-scope budget pre-check when `user.orgId` is set |

## Telemetry backends

| Backend | Config |
|---------|--------|
| Jaeger / Tempo | `{ exporter: 'otel', otel: { endpoint: 'http://localhost:4318' } }` |
| Datadog OTLP | `{ exporter: 'otel', otel: { endpoint: 'https://otlp.datadoghq.com', headers: { 'DD-API-KEY': key } } }` |
| Langfuse | `{ exporter: 'langfuse', langfuse: { publicKey, secretKey } }` |
| Honeycomb | `{ exporter: 'otel', otel: { endpoint: 'https://api.honeycomb.io', headers: { 'x-honeycomb-team': key } } }` |
| Webhook | `{ exporter: 'webhook', webhook: { url } }` |

Missing required exporter fields log a warning at startup.

## SSE streaming

`streamAgentToSse(agent, input, res)` bridges `Agent.stream()` to Server-Sent Events for NestJS controllers.

## Health

`OttrixHealthIndicator` integrates with `@nestjs/terminus` to ping configured LLM providers.

## Feature module tool registration

When `forFeature({ tools: [...], agents: [...] })` registers tools and agents together, agent factories depend on `OTTRIX_FEATURE_TOOLS` to guarantee tools are registered before agents are constructed. Unknown tool names in agent config throw at startup.

# NestJS integration (`@ottrix/nestjs`)

Thin NestJS adapter for Ottrix. Registers core primitives in Nest DI and wires HTTP lifecycle — **no agent, provider, or guardrail logic** lives in this package.

Package README: [`../README.md`](../README.md)

## Install

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

Requires **`ottrix` ≥2.0.0**. Optional: `@nestjs/terminus`.

## Architecture

```
AppModule
  └── OttrixModule.forRoot()     → ProviderRegistry, ToolRegistry, Telemetry, lifecycle
  └── OttrixModule.forFeature()  → named Agent instances (core createAgent)
  └── Controllers / Services     → @InjectAgent(), agent.run(), createSseStream()
```

All AI behavior delegates to `ottrix` core:

| NestJS component | Core API |
|------------------|----------|
| `forRoot` providers | `createAnthropicProvider`, `createOpenAIProvider`, `createOllamaProvider`, `ProviderRegistry` |
| `forFeature` agents | `createAgent()` |
| `RunContextInterceptor` | `runWith()` |
| `TelemetryInterceptor` | `getTelemetry().startSpan()` |
| `InjectionGuard` | `PromptInjectionGuardrail.checkInput()` |
| `createSseStream` | `Agent.stream()` |
| `OttrixHealthIndicator` | `ProviderRegistry` health + `BaseProvider.getCircuitState()` |
| `OttrixLifecycleService` | `configureTraceExportFromConfig()` / `OtelExporter`; flush on destroy |

## `OttrixModule`

| Method | Purpose |
|--------|---------|
| `forRoot(options)` | Global registries, telemetry, HTTP wiring |
| `forRootAsync(options)` | Async config; `http` option goes on async options, not inside factory |
| `forFeature({ agents })` | Named agents from `CreateAgentConfig` |

### Injection tokens

| Token | Resolves to |
|-------|-------------|
| `OTTRIX_PROVIDER_REGISTRY` | `ProviderRegistry` |
| `OTTRIX_TOOL_REGISTRY` | `ToolRegistry` |
| `OTTRIX_TELEMETRY` | `Telemetry` (from `getTelemetry()`) |
| `OTTRIX_PROVIDER_NAMES` | Registered provider name list |
| `agentToken('name')` | Named `Agent` from `forFeature` |
| `providerToken('anthropic')` | Named provider instance |

### Decorators

- `@InjectAgent('name')`
- `@InjectProvider('anthropic')` or `@InjectProvider()` for the full registry
- `@InjectToolRegistry()`
- `@InjectTelemetry()`

## HTTP wiring

By default, `forRoot` registers global interceptors (no extra `AppModule` providers needed):

| Default | Component |
|---------|-----------|
| On | `RunContextInterceptor` → `APP_INTERCEPTOR` |
| On | `TelemetryInterceptor` → `APP_INTERCEPTOR` |
| Off | `InjectionGuard` → `APP_GUARD` |

```typescript
OttrixModule.forRoot({
  providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
  http: true,  // also enables InjectionGuard
});

OttrixModule.forRoot({
  providers: { ... },
  http: false, // disable all automatic HTTP wiring
});
```

**RunContextInterceptor** — `runId` from `x-request-id`; optional `orgId` / `userId` from headers or custom extractors via `OTTRIX_RUN_CONTEXT_OPTIONS`.

**TelemetryInterceptor** — span per request with method, route, status, duration. RunContext attributes are attached by core when RunContext interceptor runs first (Nest registers RunContext before Telemetry).

**InjectionGuard** — scans configurable body field (default `message`); `block` throws `ForbiddenException`, `flag` logs and passes through. Configure via `http.injectionGuard` or `OTTRIX_INJECTION_GUARD_OPTIONS`.

Manual wiring (when `http: false`):

```typescript
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { InjectionGuard, RunContextInterceptor, TelemetryInterceptor } from '@ottrix/nestjs';

providers: [
  { provide: APP_INTERCEPTOR, useClass: RunContextInterceptor },
  { provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor },
  { provide: APP_GUARD, useClass: InjectionGuard },
],
```

## Agents and tools

`forFeature` accepts core `CreateAgentConfig` fields plus `name`:

```typescript
OttrixModule.forFeature({
  agents: [{
    name: 'researcher',
    systemPrompt: 'You are a researcher.',
    provider: 'anthropic',
    tools: [myTool],
    guardrails: { budget: { maxSteps: 10 } },
    memory: true,
  }],
});
```

- **`provider` omitted** — agent uses the full `ProviderRegistry` (respects fallback chain).
- **`tools`** — pass `BaseTool[]` in agent config; not resolved from global registry by name.
- **`guardrails` / `memory`** — forwarded to `createAgent()`; see [configuration.md](../../core/docs/configuration.md) and [guardrails.md](../../core/docs/guardrails.md).

## Telemetry backends

| Backend | Config |
|---------|--------|
| Console | `{ exporter: 'console' }` |
| Langfuse | `{ exporter: 'langfuse', langfuse: { publicKey, secretKey } }` |
| Braintrust | `{ exporter: 'braintrust', braintrust: { apiKey, projectName } }` |
| Webhook | `{ exporter: 'webhook', webhook: { url } }` |
| Jaeger / Tempo / Datadog / Honeycomb | `{ exporter: 'otel', otel: { endpoint, headers?, serviceName? } }` |

Import runtime APIs from main `ottrix` entry (not subpaths) to avoid duplicate singletons:

```typescript
import { getTelemetry, OtelExporter } from 'ottrix';
```

## SSE

`createSseStream(agent, message, { signal?, keepaliveMs? })` returns `Observable<MessageEvent>` for `@Sse()` endpoints.

## Health

`OttrixHealthIndicator.check()` pings configured providers and reports circuit breaker states. Use with `@nestjs/terminus` `HealthCheckService`.

## Lifecycle

`OttrixLifecycleService`:

- **OnModuleInit** — configures telemetry exporters, logs provider summary
- **OnModuleDestroy** — flushes trace exporters

## What this package does not do

- Agent loop, tool execution, memory, orchestration, or guardrail middleware logic
- Automatic tool registration into agents from global `ToolRegistry`
- DAG workflows or MCP server lifecycle (use core APIs directly)

For those features, import from `ottrix` in your Nest services and wire through DI yourself.

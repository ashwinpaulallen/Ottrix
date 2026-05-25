# @ottrix/nestjs documentation

> Part of **[Ottrix](../../../README.md)** — see [package index](../../../docs/README.md) for all `@ottrix/*` packages.

Thin NestJS adapter for Ottrix — dependency injection, HTTP interceptors, guards, SSE, and health checks. All AI logic lives in **`ottrix`** core.

Package quick start: [../README.md](../README.md)

## Guides

| Document | Scope |
|----------|--------|
| [Integration guide](./guide.md) | Full module reference, HTTP wiring, agents, telemetry, SSE, health |

## Implemented features

| Feature | Status | Details |
|---------|--------|---------|
| `OttrixModule.forRoot` | ✅ | `ProviderRegistry`, `ToolRegistry`, `Telemetry`, lifecycle |
| `OttrixModule.forRootAsync` | ✅ | Factory / `useClass` / `useExisting` |
| `OttrixModule.forFeature` | ✅ | Named agents via core `createAgent()` |
| HTTP auto-wiring | ✅ | Default RunContext + telemetry interceptors; opt-in injection guard |
| `@InjectAgent` | ✅ | Named agent injection |
| `@InjectProvider` | ✅ | Named provider or full registry |
| `@InjectToolRegistry` | ✅ | Global `ToolRegistry` token |
| `@InjectTelemetry` | ✅ | `getTelemetry()` singleton |
| `RunContextInterceptor` | ✅ | `runWith()` per request |
| `TelemetryInterceptor` | ✅ | HTTP spans via core telemetry |
| `InjectionGuard` | ✅ | `PromptInjectionGuardrail.checkInput()` |
| `createSseStream` | ✅ | `Agent.stream()` → NestJS SSE |
| `OttrixHealthIndicator` | ✅ | Provider ping + circuit breaker state |
| `OttrixLifecycleService` | ✅ | Telemetry setup + flush on destroy |

## Core docs (referenced by agents & guardrails)

- [Configuration](../../core/docs/configuration.md)
- [Guardrails](../../core/docs/guardrails.md)
- [Run context](../../core/docs/context.md)
- [Observability](../../core/docs/observability.md)

## Not in this package

Agent loop, provider implementations, guardrail middleware logic, memory, orchestration, MCP lifecycle — use **`ottrix`** directly or inject core types via Nest DI.

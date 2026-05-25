# @ottrix/fastify documentation

> Part of **[Ottrix](../../../README.md)** — see [package index](../../../docs/README.md) for all `@ottrix/*` packages.

Thin Fastify adapter for Ottrix — plugin, agent routes, hooks, and error mapping. Shared HTTP logic lives in **`ottrix/http`**.

Package quick start: [../README.md](../README.md)

## Implemented features

| Feature | Status | API |
|---------|--------|-----|
| Ottrix plugin | ✅ | `ottrixPlugin()` — decorates `fastify.ottrix` |
| Agent routes | ✅ | `agentRoutes()` — `POST /`, `GET /stream` |
| Run context ALS | ✅ | `onRequest` hook via `runWith()` |
| Prompt injection guard | ✅ | `preHandler` hook (opt-in via `injection`) |
| HTTP telemetry | ✅ | `onRequest` + `onResponse` spans |
| SSE streaming | ✅ | `reply.raw` + keepalive |
| Error mapping | ✅ | `setErrorHandler` via `mapOttrixError` from `ottrix/http` |
| Graceful shutdown | ✅ | `onClose` hook flushes telemetry |

## Not in this package

Agent loop, providers, guardrail logic, memory, orchestration — use **`ottrix`** core.

## Related docs

- [Run context](../../core/docs/context.md)
- [Guardrails](../../core/docs/guardrails.md)
- [Observability](../../core/docs/observability.md)
- [Express adapter](../../express/docs/) — similar HTTP adapter

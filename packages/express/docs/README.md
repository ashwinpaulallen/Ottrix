# @ottrix/express documentation

> Part of **[Ottrix](../../README.md)** — see [package index](../../../docs/README.md) for all `@ottrix/*` packages.

Thin Express adapter for Ottrix — middleware, router factory, SSE, and error mapping.

Package quick start: [../README.md](../README.md)

## Implemented features

| Feature | Status | API |
|---------|--------|-----|
| Agent router | ✅ | `createAgentRouter({ agent })` — `POST /`, `GET /stream` |
| Run context ALS | ✅ | `runContextMiddleware()` |
| HTTP telemetry | ✅ | `telemetryMiddleware()` |
| Prompt injection guard | ✅ | `injectionMiddleware({ mode: 'block' \| 'flag' })` |
| Budget pre-check | ✅ | `budgetMiddleware()` |
| SSE streaming | ✅ | `sendAgentStream()` + router `GET /stream` |
| Error mapping | ✅ | `ottrixErrorHandler()` |

## Not in this package

Agent loop, providers, guardrail logic, memory, orchestration — use **`ottrix`** core or inject via middleware.

## Related docs

- [ottrix core](../../core/docs/README.md)
- [All Ottrix packages](../../../docs/README.md)
- [Guardrails](../../core/docs/guardrails.md)
- [Observability](../../core/docs/observability.md)
- [NestJS adapter](../../nestjs/docs/) — alternative for structured apps

# @ottrix/hono documentation

> Part of **[Ottrix](../../../README.md)** — see [package index](../../../docs/README.md) for all `@ottrix/*` packages.

Thin Hono adapter for Ottrix — middleware, agent handlers, and error mapping. Edge-compatible (Workers, Deno, Bun, Node).

Package quick start: [../README.md](../README.md)

## Implemented features

| Feature | Status | API |
|---------|--------|-----|
| Run context ALS | ✅ | `ottrixContext()` |
| Prompt injection guard | ✅ | `ottrixInjection()` |
| HTTP telemetry | ✅ | `ottrixTelemetry()` |
| Agent POST handler | ✅ | `agentHandler(agent)` |
| Agent SSE handler | ✅ | `agentStreamHandler(agent)` |
| Error mapping | ✅ | `ottrixErrorHandler()` |

## Not in this package

Agent loop, providers, guardrail logic, memory, orchestration — use **`ottrix`** core.

## Related docs

- [Run context](../../core/docs/context.md)
- [Guardrails](../../core/docs/guardrails.md)
- [Tools & MCP](../../core/docs/tools.md)
- [Express adapter](../../express/docs/) — similar HTTP adapter

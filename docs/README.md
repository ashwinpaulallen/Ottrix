# Ottrix documentation

This folder documents **what is implemented** in the current codebase. It is derived from source under `src/` and does not describe planned or external features.

## Module index

| Document | Scope |
|----------|--------|
| [Overview](./overview.md) | Package layout, subpath exports, version constant |
| [Run context](./context.md) | `RunContext`, AsyncLocalStorage, `runWith`, `withStep` |
| [Agent](./agent.md) | `Agent`, ReAct loop, structured output (Zod), planner, reflector |
| [Configuration](./configuration.md) | `loadConfig`, environment variables, `createAgent`, `quickAgent` |
| [Providers](./providers.md) | Anthropic, OpenAI, Ollama, fallback chain, circuit breaker |
| [Tools](./tools.md) | `FunctionTool`, `createTool` (Zod), MCP, tool safety, idempotency, approval |
| [Memory](./memory.md) | Working, semantic, episodic, observational memory |
| [Guardrails](./guardrails.md) | Middleware, multi-scope budget, audit emitter, prompt injection |
| [Observability](./observability.md) | Logger, telemetry, OTEL exporter, trace exporters, replay |
| [Orchestration](./orchestration.md) | Sequential, supervisor, DAG, state stores, approval gates |
| [NestJS](./nestjs.md) | `@ottrix/nestjs` DI adapter, guards, interceptors, SSE |
| [Evals](./evals.md) | `evaluate()`, scorers, `EvalReporter` |
| [Types](./types.md) | Shared TypeScript contracts |

## Branch coverage (`RunContext-via-AsyncLocalStorage`)

| Commit | Feature | Doc |
|--------|---------|-----|
| `7895d45` | RunContext via ALS | [context.md](./context.md) |
| `1039351` | Tool safety envelope + idempotency | [tools.md](./tools.md) |
| `1039351` | Redis/Postgres state stores | [orchestration.md](./orchestration.md) |
| `1039351` | Human approval gates | [orchestration.md](./orchestration.md) |
| `a40ea26` | OTEL exporter | [observability.md](./observability.md) |
| `a40ea26` | Multi-scope budget + USD cost | [guardrails.md](./guardrails.md) |
| `a40ea26` | AuditEmitter | [guardrails.md](./guardrails.md) |
| `a40ea26` | `@ottrix/nestjs` | [nestjs.md](./nestjs.md) |

## Related files

- [README.md](../README.md) — user-facing quick start
- [CHANGELOG.md](../CHANGELOG.md) — release history
- [packages/nestjs/README.md](../packages/nestjs/README.md) — NestJS package quick start
- [examples/](../examples/) — runnable samples

## Generating API reference HTML

```bash
npm run docs
# Output: docs/api/ (gitignored)
```

TypeDoc HTML is supplementary; these markdown files are the authoritative module guides tied to implementation.

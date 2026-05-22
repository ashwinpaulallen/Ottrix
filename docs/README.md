# agent-kit documentation

This folder documents **what is implemented** in the current codebase. It is derived from source under `src/` and does not describe planned or external features.

## Module index

| Document | Scope |
|----------|--------|
| [Overview](./overview.md) | Package layout, subpath exports, version constant |
| [Agent](./agent.md) | `Agent`, ReAct loop, structured output (Zod), planner, reflector |
| [Configuration](./configuration.md) | `loadConfig`, environment variables, `createAgent`, `quickAgent` |
| [Providers](./providers.md) | Anthropic, OpenAI, Ollama, fallback chain, circuit breaker |
| [Tools](./tools.md) | `FunctionTool`, `createTool` (Zod), MCP client/server, tool approval |
| [Memory](./memory.md) | Working, semantic, episodic, observational memory |
| [Guardrails](./guardrails.md) | Middleware, validators, budget, audit, prompt injection (default) |
| [Observability](./observability.md) | Logger, telemetry, trace exporters, retention, run replay |
| [Orchestration](./orchestration.md) | Sequential, supervisor, DAG, suspend/resume, YAML loader |
| [Evals](./evals.md) | `evaluate()`, scorers, `EvalReporter` |
| [Types](./types.md) | Shared TypeScript contracts |

## v2 branch coverage

All commits on the v2 feature branch are documented:

| Commit | Feature | Doc |
|--------|---------|-----|
| `9a7d1db` | Structured output (Zod) | [agent.md](./agent.md) |
| `9e15667` | Fallback chain, circuit breaker | [providers.md](./providers.md) |
| `0dfd9ad` | Zod tools, tool approval | [tools.md](./tools.md) |
| `6e2b75f` | Observational memory | [memory.md](./memory.md) |
| `0b66e65` | Supervisor, DAG, suspend/resume | [orchestration.md](./orchestration.md) |
| `8887e9e` | Evals, trace exporters, retention | [evals.md](./evals.md), [observability.md](./observability.md) |
| `49b5df6` | Prompt injection (default) | [guardrails.md](./guardrails.md) |

Also updated: [overview.md](./overview.md), [configuration.md](./configuration.md), [types.md](./types.md), [MIGRATION.md](../MIGRATION.md).

## Related files

- [README.md](../README.md) — user-facing quick start
- [CONTRIBUTING.md](../CONTRIBUTING.md) — development guidelines
- [MIGRATION.md](../MIGRATION.md) — version upgrades
- [CHANGELOG.md](../CHANGELOG.md) — release history
- [examples/](../examples/) — runnable samples

## Generating API reference HTML

```bash
npm run docs
# Output: docs/api/ (gitignored)
```

TypeDoc HTML is supplementary; these markdown files are the authoritative module guides tied to implementation.

# agentic-fabric documentation

This folder documents **what is implemented** in the current codebase. It is derived from source under `src/` and does not describe planned or external features.

## Module index

| Document | Scope |
|----------|--------|
| [Overview](./overview.md) | Package layout, subpath exports, version constant |
| [Agent](./agent.md) | `Agent`, ReAct loop, planner, reflector, context manager |
| [Configuration](./configuration.md) | `loadConfig`, environment variables, `createAgent`, `quickAgent` |
| [Providers](./providers.md) | Anthropic, OpenAI, Ollama, `BaseProvider`, `ProviderRegistry` |
| [Tools](./tools.md) | `FunctionTool`, `ToolRegistry`, MCP client and transports |
| [Memory](./memory.md) | Working, semantic, episodic memory; embeddings; vector store |
| [Guardrails](./guardrails.md) | Middleware, validators, budget, audit, human approval |
| [Observability](./observability.md) | Logger, telemetry, spans, exporters, run replay |
| [Orchestration](./orchestration.md) | Workflows, YAML/JSON loader, routing |
| [Types](./types.md) | Shared TypeScript contracts |

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

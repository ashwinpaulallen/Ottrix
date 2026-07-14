# Ottrix core documentation

Implementation-accurate guides for the **`ottrix`** npm package (`packages/core`). Each document tracks **what is implemented today** — not planned features.

**What is Ottrix?** A TypeScript framework for production LLM agents — ReAct loop, tools, memory, guardrails, workflows, evals, and observability with zero vendor SDK dependencies.

- Package quick start: [../README.md](../README.md)
- **All monorepo packages:** [../../docs/README.md](../../docs/README.md)

## Module guides

| Document | Scope |
|----------|--------|
| [Overview](./overview.md) | Subpath exports, version constant, architectural layers |
| [Run context](./context.md) | `RunContext`, AsyncLocalStorage, `runWith`, `withStep` |
| [Agent](./agent.md) | `Agent`, ReAct loop, structured output (Zod), planner, reflector |
| [Self-evaluation](./self-evaluation.md) | In-loop sufficiency checks, refinement, cheap eval models |
| [Configuration](./configuration.md) | `loadConfig`, environment variables, `createAgent`, `quickAgent` |
| [Providers](./providers.md) | Anthropic, OpenAI, Ollama, fallback chain, circuit breaker |
| [Tools](./tools.md) | `FunctionTool`, `createTool` (Zod), MCP **client**, tool safety, idempotency |
| [Memory](./memory.md) | Working, semantic, episodic, observational memory |
| [Guardrails](./guardrails.md) | Middleware, multi-scope budget, audit emitter, prompt injection |
| [Observability](./observability.md) | Logger, telemetry, built-in exporters, standalone `@ottrix/exporter-*` |
| [Orchestration](./orchestration.md) | Sequential, supervisor, DAG, state stores, approval gates |
| [Evals](./evals.md) | `evaluate()`, scorers, `EvalReporter` |
| [Types](./types.md) | Shared TypeScript contracts |

## Implemented feature index

| Area | Key APIs | Doc |
|------|----------|-----|
| Agent loop | `Agent`, `createAgent`, `quickAgent` | [agent.md](./agent.md), [configuration.md](./configuration.md) |
| Self-evaluation | `evaluation`, `createEvaluator`, refinement events | [self-evaluation.md](./self-evaluation.md) |
| Structured output | `zodToJsonSchema`, Zod validation | [agent.md](./agent.md) |
| Providers | `createAnthropicProvider`, `ProviderRegistry`, fallback | [providers.md](./providers.md) |
| Tools | `FunctionTool`, `createTool`, `ToolRegistry`, MCP client | [tools.md](./tools.md) |
| MCP server | `@ottrix/mcp-server` — `serveMCP`, `ottrix-serve` CLI | [tools.md](./tools.md) |
| Memory | `WorkingMemory`, `SemanticMemory`, `ObservationalMemory` | [memory.md](./memory.md) |
| Guardrails | `createGuardrails`, `configureBudgets`, `AuditEmitter` | [guardrails.md](./guardrails.md) |
| Prompt injection | `PromptInjectionGuardrail` | [guardrails.md](./guardrails.md) |
| Telemetry | `getTelemetry`, replay, built-in exporters | [observability.md](./observability.md) |
| OTEL / Langfuse / Braintrust | `@ottrix/exporter-otel`, `-langfuse`, `-braintrust` | [observability.md](./observability.md) |
| Workflows | `SequentialWorkflow`, `SupervisorWorkflow`, `DAGBuilder` | [orchestration.md](./orchestration.md) |
| State stores | `InMemoryStateStore`, `PostgresStateStore`, `RedisStateStore` | [orchestration.md](./orchestration.md) |
| Run context | `runWith`, `getRunContext`, ALS propagation | [context.md](./context.md) |
| Evals | `evaluate`, scorers, CSV/Markdown reports | [evals.md](./evals.md) |

## Related packages

| Category | Packages |
|----------|----------|
| HTTP adapters | [`@ottrix/nestjs`](../../nestjs/docs/), [`@ottrix/express`](../../express/docs/), [`@ottrix/fastify`](../../fastify/docs/), [`@ottrix/hono`](../../hono/docs/) |
| Framework bridges | [`@ottrix/vercel-ai`](../../vercel-ai/README.md), [`@ottrix/langchain`](../../langchain/README.md), [`@ottrix/mastra`](../../mastra/README.md) |
| Trace exporters | [`@ottrix/exporter-otel`](../../exporter-otel/README.md), [`@ottrix/exporter-langfuse`](../../exporter-langfuse/README.md), [`@ottrix/exporter-braintrust`](../../exporter-braintrust/README.md) |
| MCP server | [`@ottrix/mcp-server`](../../mcp-server/README.md) |

Full index: [../../docs/README.md](../../docs/README.md)

## API reference (HTML)

```bash
npm run docs
# Output: docs/api/ at repo root (gitignored)
```

TypeDoc HTML is supplementary; these markdown files are the authoritative module guides tied to implementation.

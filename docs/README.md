# Ottrix monorepo documentation

**[Ottrix](https://github.com/ashwinpaulallen/ottrix)** is a TypeScript framework for production LLM agents: ReAct loop, tools, memory, guardrails, observability, evals, multi-agent workflows, and [MCP](https://modelcontextprotocol.io/) client support — with **zero vendor SDK dependencies** (Anthropic, OpenAI-compatible, and Ollama via native `fetch`).

This monorepo splits the framework into a **focused core** (`ottrix`) and **optional packages** you install only when needed. Documentation lives next to the code under `packages/*/`.

**Quick links:** [Root README](../README.md) · [MIGRATION.md](../MIGRATION.md) · [CHANGELOG.md](../CHANGELOG.md) · [examples/](../examples/)

---

## Package map

Install **`ottrix`** first. Add other `@ottrix/*` packages as your stack requires.

### Core

| Package | npm install | Description | Docs |
|---------|-------------|-------------|------|
| **`ottrix`** | `npm install ottrix` | Agent loop, providers, tools, MCP **client**, memory, guardrails, workflows, evals, built-in trace exporters (console, webhook) | [packages/core/README.md](../packages/core/README.md) · [module guides](../packages/core/docs/README.md) |

**Core subpaths:** `ottrix/providers`, `ottrix/tools`, `ottrix/memory`, `ottrix/orchestration`, `ottrix/guardrails`, `ottrix/observability`, `ottrix/evals`, `ottrix/exporters/webhook`, `ottrix/types`

### HTTP server adapters

Thin wrappers for RunContext, telemetry, injection guards, SSE streaming, and error mapping. **Agent logic stays in core.**

| Package | npm install | Framework | Docs |
|---------|-------------|-----------|------|
| **`@ottrix/nestjs`** | `npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs` | NestJS module, DI, interceptors, guards | [README](../packages/nestjs/README.md) · [guide](../packages/nestjs/docs/guide.md) |
| **`@ottrix/express`** | `npm install @ottrix/express ottrix express` | Express middleware & router | [README](../packages/express/README.md) · [docs](../packages/express/docs/README.md) |
| **`@ottrix/fastify`** | `npm install @ottrix/fastify ottrix fastify` | Fastify plugin & routes | [README](../packages/fastify/README.md) · [docs](../packages/fastify/docs/README.md) |
| **`@ottrix/hono`** | `npm install @ottrix/hono ottrix hono` | Hono middleware (Node, Bun, Deno, edge) | [README](../packages/hono/README.md) · [docs](../packages/hono/docs/README.md) |

### Framework bridges

Use Ottrix providers, tools, and agents inside other AI ecosystems.

| Package | npm install | Integrates with | Docs |
|---------|-------------|-----------------|------|
| **`@ottrix/vercel-ai`** | `npm install @ottrix/vercel-ai ottrix ai` | [Vercel AI SDK](https://sdk.vercel.ai/) — `LanguageModelV1`, tools | [README](../packages/vercel-ai/README.md) |
| **`@ottrix/langchain`** | `npm install @ottrix/langchain ottrix @langchain/core` | [LangChain.js](https://js.langchain.com/) — chat model, tools, memory | [README](../packages/langchain/README.md) |
| **`@ottrix/mastra`** | `npm install @ottrix/mastra ottrix @mastra/core` | [Mastra](https://mastra.ai/) — models, tools, agent wrapper | [README](../packages/mastra/README.md) |

### Observability exporters

Trace export to external backends. Register with `getTelemetry().addExporter(...)` from core.

| Package | npm install | Destination | Docs |
|---------|-------------|-------------|------|
| **`@ottrix/exporter-otel`** | `npm install @ottrix/exporter-otel ottrix` | OTLP/HTTP — Jaeger, Tempo, Datadog, Honeycomb | [README](../packages/exporter-otel/README.md) |
| **`@ottrix/exporter-langfuse`** | `npm install @ottrix/exporter-langfuse ottrix` | [Langfuse](https://langfuse.com/) ingestion API | [README](../packages/exporter-langfuse/README.md) |
| **`@ottrix/exporter-braintrust`** | `npm install @ottrix/exporter-braintrust ottrix` | [Braintrust](https://www.braintrust.dev/) project logs | [README](../packages/exporter-braintrust/README.md) |

> **Breaking change (v2.1):** Langfuse, Braintrust, OTel, and MCP **server** moved out of core. See [MIGRATION.md](../MIGRATION.md).

### MCP server

| Package | npm install | Description | Docs |
|---------|-------------|-------------|------|
| **`@ottrix/mcp-server`** | `npm install @ottrix/mcp-server ottrix` | Host ottrix tools as an MCP server (stdio/SSE) + **`ottrix-serve`** CLI | [README](../packages/mcp-server/README.md) |

Core keeps the MCP **client** (`MCPClient`, `MCPRegistry`) for connecting *to* external MCP servers.

---

## Core module guides

Implementation-accurate reference for the **`ottrix`** package:

| Document | Topic |
|----------|--------|
| [overview.md](../packages/core/docs/overview.md) | Subpath exports, architecture |
| [agent.md](../packages/core/docs/agent.md) | ReAct loop, structured output |
| [configuration.md](../packages/core/docs/configuration.md) | `loadConfig`, `createAgent` |
| [providers.md](../packages/core/docs/providers.md) | LLM backends, fallback, circuit breaker |
| [tools.md](../packages/core/docs/tools.md) | Tools, MCP client, idempotency |
| [memory.md](../packages/core/docs/memory.md) | Working, semantic, episodic, observational |
| [guardrails.md](../packages/core/docs/guardrails.md) | Budgets, audit, prompt injection |
| [observability.md](../packages/core/docs/observability.md) | Telemetry, exporters, replay |
| [orchestration.md](../packages/core/docs/orchestration.md) | Workflows, DAG, state stores |
| [context.md](../packages/core/docs/context.md) | `runWith`, AsyncLocalStorage |
| [evals.md](../packages/core/docs/evals.md) | Datasets, scorers, reports |
| [types.md](../packages/core/docs/types.md) | Shared TypeScript types |

Full index: [packages/core/docs/README.md](../packages/core/docs/README.md)

---

## Typical stacks

**Minimal agent (CLI or script)**

```bash
npm install ottrix zod
```

**Production API (NestJS)**

```bash
npm install ottrix @ottrix/nestjs @ottrix/exporter-otel @nestjs/common @nestjs/core rxjs
```

**Expose tools to Claude Desktop**

```bash
npm install ottrix @ottrix/mcp-server
npx ottrix-serve --transport stdio
```

**Vercel AI SDK app with Ottrix resilience**

```bash
npm install ottrix @ottrix/vercel-ai ai
```

**Langfuse + LangChain**

```bash
npm install ottrix @ottrix/langchain @ottrix/exporter-langfuse @langchain/core
```

---

## Other resources

- [Root README](../README.md) — overview, quick start, architecture
- [CHANGELOG.md](../CHANGELOG.md) — release history
- [MIGRATION.md](../MIGRATION.md) — upgrade guide (incl. v2.1 exporter/MCP moves)
- [examples/](../examples/) — workflow YAML samples and [HTTP adapter demos](../examples/http-agents/)

## API reference (HTML)

```bash
npm run docs
# Output: docs/api/ (gitignored)
```

TypeDoc HTML is supplementary; package markdown guides are the authoritative implementation docs.

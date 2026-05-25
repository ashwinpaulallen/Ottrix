# Ottrix

**TypeScript framework for building production LLM agents** — ReAct loop, structured output, tool calling, memory, guardrails, observability, evals, multi-agent workflows, and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) client support (MCP **server** via `@ottrix/mcp-server`). Vendor-neutral: Anthropic Claude, OpenAI-compatible APIs, and local Ollama via native `fetch` (no `@anthropic-ai/sdk` or `openai` npm package required).

[![npm version](https://img.shields.io/npm/v/ottrix.svg)](https://www.npmjs.com/package/ottrix)
[![CI](https://img.shields.io/github/actions/workflow/status/ashwinpaulallen/ottrix/test.yml?branch=main&logo=githubactions&label=CI)](https://github.com/ashwinpaulallen/ottrix/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/ottrix)](https://www.npmjs.com/package/ottrix)

> **Keywords:** AI agent · LLM framework · TypeScript · ReAct · tool use · MCP · multi-agent · structured output · evals · Claude · GPT · Ollama · guardrails · observability

**Repository:** [github.com/ashwinpaulallen/ottrix](https://github.com/ashwinpaulallen/ottrix)

---

## Table of contents

- [Why Ottrix](#why-ottrix)
- [Requirements](#requirements)
- [Installation](#installation)
- [Packages](#packages)
- [Quick start](#quick-start)
- [Use with your backend](#use-with-your-backend)
- [Feature examples](#feature-examples)
- [More examples](#more-examples)
- [Architecture](#architecture)
- [Module documentation](#module-documentation)
- [Providers](#providers)
- [Configuration](#configuration)
- [Package exports](#package-exports)
- [Documentation & examples](#documentation--examples)
- [Comparison](#comparison)
- [Development](#development)
- [License](#license)

---

## Why Ottrix

Use **Ottrix** when you need a **small, explicit TypeScript library** to run LLM agents in Node.js — not a heavy platform or Python stack.

| You get | Details |
|---------|---------|
| **ReAct agent loop** | Call the model, execute tools, repeat until a final answer or limit |
| **Structured output** | Validate final responses with Zod schemas and automatic retries |
| **Tool calling** | JSON Schema (`FunctionTool`) or Zod (`createTool`) with typed I/O |
| **MCP** | Connect to external MCP servers (core client) **and** host your own via **`@ottrix/mcp-server`** |
| **Multi-agent workflows** | Sequential, parallel, router, hierarchical, **supervisor**, and **DAG** (with suspend/resume) |
| **Memory** | Working, semantic (RAG), episodic, and **observational** (LLM fact extraction) |
| **Guardrails** | PII, **multi-scope budgets (USD)**, content filters, human approval, **AuditEmitter**, prompt injection (default) |
| **Observability** | Spans, metrics, run replay; exporters via **`@ottrix/exporter-*`** packages |
| **NestJS** | **`@ottrix/nestjs`** — DI module, guards, interceptors, SSE, health checks |
| **Evals** | Run datasets against agents with pluggable scorers and CSV/Markdown reports |
| **Provider resilience** | Fallback chains and per-provider circuit breakers |
| **Zero vendor SDKs** | Built-in providers use HTTP APIs only — smaller installs, full control |

Ideal for backend services, CLI agents, automation scripts, internal copilots, and TypeScript teams comparing alternatives to LangChain.js, CrewAI, or AutoGen.

---

## Requirements

- **Node.js** **20+** (`>=20`; CI tests 20, 22, and 24)
- An API key for **Anthropic** or **OpenAI**, or a local **[Ollama](https://ollama.com/)** server

---

## Installation

```bash
npm install ottrix
```

```bash
# yarn
yarn add ottrix

# pnpm
pnpm add ottrix
```

**Optional peer dependencies:**

```bash
# Structured output, Zod tools, schema-based eval scorers
npm install zod

# Full YAML workflow files (built-in subset parser works without this)
npm install js-yaml

# Redis/Postgres DAG state stores
npm install ioredis pg
```

**Standalone `@ottrix/*` packages** (MCP server, trace exporters, HTTP adapters, framework bridges) — see [docs/README.md](docs/README.md).

Set your provider key (example for Anthropic):

```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

---

## Packages

Ottrix is a **monorepo**: a focused **`ottrix`** core plus optional **`@ottrix/*`** packages. Install only what you need.

**Full package index:** [docs/README.md](docs/README.md)

### Core

| Package | Install | Description |
|---------|---------|-------------|
| **`ottrix`** | `npm install ottrix` | **v2.1.0** — ReAct agents, providers, tools, MCP client, memory, guardrails, workflows, evals, webhook/console exporters |

Optional peers: `zod`, `js-yaml`, `ioredis`, `pg` — see [Installation](#installation).

### HTTP adapters

| Package | Install | Status |
|---------|---------|--------|
| **`@ottrix/nestjs`** | `npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs` | Published — [README](packages/nestjs/README.md) |
| **`@ottrix/express`** | `npm install @ottrix/express ottrix express` | Implemented — [README](packages/express/README.md) |
| **`@ottrix/fastify`** | `npm install @ottrix/fastify ottrix fastify` | Implemented — [README](packages/fastify/README.md) |
| **`@ottrix/hono`** | `npm install @ottrix/hono ottrix hono` | Implemented — [README](packages/hono/README.md) |
| **`@ottrix/nextjs`** | `npm install @ottrix/nextjs ottrix next` | Published — [README](packages/nextjs/README.md) |

### Framework bridges

| Package | Install | Integrates with |
|---------|---------|-----------------|
| **`@ottrix/vercel-ai`** | `npm install @ottrix/vercel-ai ottrix ai` | [Vercel AI SDK](https://sdk.vercel.ai/) — [README](packages/vercel-ai/README.md) |
| **`@ottrix/langchain`** | `npm install @ottrix/langchain ottrix @langchain/core` | [LangChain.js](https://js.langchain.com/) — [README](packages/langchain/README.md) |
| **`@ottrix/mastra`** | `npm install @ottrix/mastra ottrix @mastra/core` | [Mastra](https://mastra.ai/) — [README](packages/mastra/README.md) |

### Observability exporters

Moved out of core in **v2.1** — register with `getTelemetry().addExporter(...)`. See [MIGRATION.md](MIGRATION.md).

| Package | Install | Destination |
|---------|---------|-------------|
| **`@ottrix/exporter-otel`** | `npm install @ottrix/exporter-otel ottrix` | OTLP/HTTP (Jaeger, Tempo, Datadog, …) — [README](packages/exporter-otel/README.md) |
| **`@ottrix/exporter-langfuse`** | `npm install @ottrix/exporter-langfuse ottrix` | Langfuse — [README](packages/exporter-langfuse/README.md) |
| **`@ottrix/exporter-braintrust`** | `npm install @ottrix/exporter-braintrust ottrix` | Braintrust — [README](packages/exporter-braintrust/README.md) |

Built into core: `WebhookExporter`, `TraceConsoleExporter`, `MultiExporter` via `ottrix/exporters/webhook` and the main barrel.

### MCP server

| Package | Install | Description |
|---------|---------|-------------|
| **`@ottrix/mcp-server`** | `npm install @ottrix/mcp-server ottrix` | Host ottrix tools over MCP (stdio/SSE) + **`npx ottrix-serve`** CLI — [README](packages/mcp-server/README.md) |

Core keeps the MCP **client** (`MCPClient`, `MCPRegistry`) for connecting to external servers.

**Core module docs:** [packages/core/docs/](packages/core/docs/README.md) · **Core README:** [packages/core/README.md](packages/core/README.md)

---

## Quick start

Minimal agent in under 10 lines:

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  systemPrompt: 'You are a helpful assistant.',
});

const { response } = await agent.run('What is 2 + 2?');
console.log(response);
```

Prompt injection protection, PII detection, and step/token budgets are **enabled by default** — no extra configuration required.

---

## Use with your backend

Expose any Ottrix agent over HTTP with one adapter — **same routes, same JSON, same SSE wire format** regardless of framework:

```ts
import express from 'express';
import { createAgent } from 'ottrix';
import { createAgentRouter } from '@ottrix/express';

const app = express();
app.use(express.json());
app.use('/chat', createAgentRouter({
  agent: createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' }),
}));
app.listen(3000); // POST /chat, GET /chat/stream, GET /chat/health
```

| Adapter | Install |
|---------|---------|
| Express | `@ottrix/express` — [README](packages/express/README.md) |
| Fastify | `@ottrix/fastify` — [README](packages/fastify/README.md) |
| Hono | `@ottrix/hono` — [README](packages/hono/README.md) |
| NestJS | `@ottrix/nestjs` — [README](packages/nestjs/README.md) |

**Compare all four side by side:** [BACKEND_ADAPTERS.md](BACKEND_ADAPTERS.md) (feature matrix, endpoints, SSE/error formats)

**Runnable examples:** [examples/http-agents/](examples/http-agents/) — `cd examples/http-agents/express-agent && ANTHROPIC_API_KEY=sk-... npm start`

---

One-liner helper:

```ts
import { quickAgent } from 'ottrix';

const answer = await quickAgent('Summarize TypeScript in one sentence.', {
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
console.log(answer);
```

---

## Feature examples

### Structured output (Zod)

```ts
import { createAgent } from 'ottrix';
import { z } from 'zod';

const schema = z.object({ name: z.string(), age: z.number() });
const agent = createAgent({ provider: 'anthropic' });
const { parsedOutput } = await agent.run('Introduce Ada Lovelace', { outputSchema: schema });
```

### Zod tools

```ts
import { createAgent, createTool } from 'ottrix';
import { z } from 'zod';

const weather = createTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempF: 72 }),
});

const agent = createAgent({ provider: 'anthropic', tools: [weather] });
```

### Provider fallback chain

```ts
import { ProviderRegistry, createAnthropicProvider, createOpenAIProvider } from 'ottrix/providers';

const registry = new ProviderRegistry()
  .register('anthropic', createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .setFallbackChain(['anthropic', 'openai']);

await registry.complete({ messages: [{ role: 'user', content: 'Hello' }] });
```

### MCP server

Install `@ottrix/mcp-server` — the MCP **client** stays in `ottrix`.

```ts
import { serveMCP } from '@ottrix/mcp-server';
import { ToolRegistry } from 'ottrix';

const registry = new ToolRegistry();
registry.register(myTool);
await serveMCP({ name: 'my-tools', version: '1.0.0', toolRegistry: registry, transport: 'stdio' });
```

CLI: `npx ottrix-serve --transport stdio` (requires `@ottrix/mcp-server`)

### Supervisor pattern

```ts
import { createSupervisor } from 'ottrix';

const pipeline = createSupervisor({
  provider,
  workers: {
    researcher: { systemPrompt: 'You research.', description: 'Finds facts' },
    writer: { systemPrompt: 'You write.', description: 'Drafts prose' },
  },
});

await pipeline.run('Write a blog post about RLHF');
```

### DAG workflows with suspend / resume

```ts
import { DAGBuilder } from 'ottrix';

const workflow = new DAGBuilder()
  .addStep('draft', { name: 'Draft', execute: async (input) => `Draft: ${input}` })
  .addStep('review', {
    name: 'Review',
    suspend: true,
    execute: async (input) => input,
    dependencies: ['draft'],
  })
  .build();

const suspended = await workflow.run('Quarterly update');
const done = await workflow.resume(suspended.suspendedState!, {
  workflowId: suspended.suspendedState!.workflowId,
  stepOutput: { approved: true, edits: 'Updated subject' },
});
```

### Evals

```ts
import { evaluate, ExactMatchScorer, ContainsScorer } from 'ottrix/evals';

const report = await evaluate({
  agent,
  dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
  scorers: [new ExactMatchScorer(), new ContainsScorer(['Paris'])],
});
console.log(report.aggregates.exact_match?.mean);
```

### Observability (Langfuse)

```ts
import { getTelemetry } from 'ottrix';
import { LangfuseExporter } from '@ottrix/exporter-langfuse';

getTelemetry().addExporter(
  new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  }),
);
```

### OpenTelemetry export

```ts
import { getTelemetry } from 'ottrix';
import { createOtelExporter } from '@ottrix/exporter-otel';

getTelemetry().addExporter(
  createOtelExporter('jaeger', { serviceName: 'my-agent' }),
  // endpoint defaults to http://localhost:4318
);
```

### Run context

```ts
import { createAgent, runWith } from 'ottrix';

const agent = createAgent({ provider: 'anthropic', name: 'researcher' });

await runWith({ runId: 'req-42', orgId: 'acme-corp' }, () =>
  agent.run('Summarize Q1 earnings'),
);
```

### Audit trail

```ts
import { AuditEmitter, FileSink, HmacSigner, useAudit } from 'ottrix';

useAudit(new AuditEmitter({
  sink: new FileSink({ path: './audit.jsonl' }),
  signer: new HmacSigner({ secret: process.env.AUDIT_SECRET! }),
  redact: ['args.token', 'args.password'],
}));

// All agent/tool/guardrail/workflow lifecycle events are captured automatically
```

### NestJS integration

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

```ts
import { Module } from '@nestjs/common';
import { OttrixModule } from '@ottrix/nestjs';

@Module({
  imports: [
    OttrixModule.forRoot({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
      telemetry: { exporter: 'otel', otel: { endpoint: 'http://localhost:4318' } },
    }),
  ],
})
export class AppModule {}
```

See [packages/nestjs/docs/guide.md](packages/nestjs/docs/guide.md).

### Prompt injection guardrails

Enabled automatically on every `createAgent()` call. Customize or opt out:

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({ provider: 'anthropic' }); // blocks injection by default

const flagged = createAgent({
  guardrails: { promptInjection: { mode: 'flag', strictness: 'high' } },
});

const open = createAgent({ guardrails: { promptInjection: false } });
```

---

## More examples

### Streaming responses

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! });

for await (const event of agent.stream('Explain quantum entanglement briefly.')) {
  if (event.type === 'text') {
    process.stdout.write(String((event.data as { text: string }).text));
  }
  if (event.type === 'done') process.stdout.write('\n');
}
```

### Agent with tools (function calling)

```ts
import { createAgent, FunctionTool } from 'ottrix';

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  execute: async ({ city }) => ({ city: String(city), tempF: 72, condition: 'sunny' }),
});

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  tools: [weatherTool],
  systemPrompt: 'Use tools when needed, then answer concisely.',
});

const result = await agent.run('What is the weather in Paris?');
console.log(result.response);
```

### Custom agent (full control)

```ts
import { Agent, ToolRegistry, FunctionTool } from 'ottrix';
import { createAnthropicProvider } from 'ottrix/providers';

const registry = new ToolRegistry();
registry.register(
  new FunctionTool({
    name: 'echo',
    description: 'Echo input text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async ({ text }) => String(text),
  }),
);

const agent = new Agent({
  name: 'echo-agent',
  provider: createAnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  }),
  toolRegistry: registry,
  systemPrompt: 'You are a helpful assistant.',
  maxSteps: 10,
});

const { response } = await agent.run('Echo the word hello');
```

### Multi-agent pipeline (sequential)

```ts
import { Agent, SequentialWorkflow } from 'ottrix';
import { createAnthropicProvider } from 'ottrix/providers';

const provider = createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });

const researcher = new Agent({ name: 'researcher', provider, systemPrompt: 'Gather concise research notes.' });
const writer = new Agent({ name: 'writer', provider, systemPrompt: 'Write a short, clear summary.' });

const pipeline = new SequentialWorkflow([
  { agent: researcher, inputMapper: ({ originalInput }) => `Research: ${originalInput}` },
  {
    agent: writer,
    inputMapper: (_ctx, prev) => `Write a summary from these notes:\n${prev?.response ?? ''}`,
  },
]);

const output = await pipeline.run('Benefits of multi-agent AI systems');
console.log(output.finalResult.response);
```

### OpenAI-compatible API

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
});
```

### Local models with Ollama

```bash
ollama serve && ollama pull llama3.1
```

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({
  provider: 'ollama',
  model: 'llama3.1',
  baseUrl: 'http://localhost:11434',
});
```

### Guardrails and budgets

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  maxSteps: 5,
  guardrails: {
    pii: { blockOnDetect: true },
    budget: { maxSteps: 5, maxTokenBudget: 8_000 },
    promptInjection: { mode: 'block', strictness: 'medium' }, // default when omitted
  },
});
```

### Environment-based configuration

```ts
import { loadConfig, createAgent } from 'ottrix';

const { config } = loadConfig();
const agent = createAgent({ provider: config.defaultProvider, model: config.defaultModel });
```

Example `.ottrixrc.json` (legacy `.agentkitrc.*` / `.agenticrc.*` are also supported):

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "maxSteps": 10,
  "telemetry": {
    "enabled": true,
    "exporter": "langfuse",
    "langfuse": {
      "publicKey": "${LANGFUSE_PUBLIC_KEY}",
      "secretKey": "${LANGFUSE_SECRET_KEY}"
    }
  }
}
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│              Your application (API, CLI, workers, MCP clients)       │
├──────────────────────────────────────────────────────────────────────┤
│  Orchestration — Sequential · Parallel · Router · Supervisor · DAG   │
│                  YAML loader · suspend/resume                        │
├──────────────────────────────────────────────────────────────────────┤
│  Agent — ReAct loop · structured output (Zod) · Planner · Reflector  │
├────────────┬─────────────┬──────────────┬─────────────┬────────────┤
│   Tools    │   Memory    │  Guardrails  │ Observability│   Evals    │
│  + MCP     │  RAG · epis.│ PII · budget │ @ottrix/    │  Scorers · │
│  client    │  observational│ injection  │ exporter-*  │  reports   │
│            │             │  (default)   │ + webhook   │            │
├────────────┴─────────────┴──────────────┴─────────────┴────────────┤
│  Providers — Anthropic · OpenAI · Ollama · fallback chain · breaker  │
├──────────────────────────────────────────────────────────────────────┤
│  Config — loadConfig() · .ottrixrc · OTTRIX_* env vars                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Module documentation

Implementation-accurate guides live in each package — index: [docs/README.md](docs/README.md).

| Module | Document | Topics |
|--------|----------|--------|
| Agent | [packages/core/docs/agent.md](packages/core/docs/agent.md) | ReAct loop, structured output, planner, reflector |
| Providers | [packages/core/docs/providers.md](packages/core/docs/providers.md) | Anthropic, OpenAI, Ollama, fallback chain, circuit breaker |
| Tools | [packages/core/docs/tools.md](packages/core/docs/tools.md) | `FunctionTool`, `createTool`, MCP client/server, tool approval |
| Memory | [packages/core/docs/memory.md](packages/core/docs/memory.md) | Working, semantic, episodic, observational memory |
| Guardrails | [packages/core/docs/guardrails.md](packages/core/docs/guardrails.md) | Middleware, multi-scope budgets, audit emitter, prompt injection |
| Observability | [packages/core/docs/observability.md](packages/core/docs/observability.md) | Telemetry, OTEL exporter, trace exporters, replay |
| Orchestration | [packages/core/docs/orchestration.md](packages/core/docs/orchestration.md) | Workflows, state stores, approval gates, DAG |
| Run context | [packages/core/docs/context.md](packages/core/docs/context.md) | AsyncLocalStorage propagation, `runWith` |
| NestJS | [packages/nestjs/docs/guide.md](packages/nestjs/docs/guide.md) | `@ottrix/nestjs` adapter |
| Framework bridges | [docs/README.md](docs/README.md#framework-bridges) | `@ottrix/vercel-ai`, `@ottrix/langchain`, `@ottrix/mastra` |
| Trace exporters | [packages/core/docs/observability.md](packages/core/docs/observability.md) | `@ottrix/exporter-*` packages |
| Evals | [packages/core/docs/evals.md](packages/core/docs/evals.md) | `evaluate()`, scorers, reports |
| Configuration | [packages/core/docs/configuration.md](packages/core/docs/configuration.md) | `loadConfig`, env vars, `createAgent` |
| Overview | [packages/core/docs/overview.md](packages/core/docs/overview.md) | Package layout, subpath exports |

Release history: [CHANGELOG.md](CHANGELOG.md) · Upgrade notes: [MIGRATION.md](MIGRATION.md)

---

## Providers

| Provider | `createAgent` | API key env | Default model |
|----------|---------------|-------------|---------------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI-compatible | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` |
| Ollama (local) | `provider: 'ollama'` | none | `llama3.1` |

Extend any HTTP API with [`BaseProvider`](packages/core/docs/providers.md):

```ts
import { BaseProvider } from 'ottrix/providers';
// Implement _rawComplete, _rawStream, _countTokens
```

---

## Configuration

Common environment variables:

| Variable | Description |
|----------|-------------|
| `OTTRIX_PROVIDER` / `OTTRIX_DEFAULT_PROVIDER` | Default provider (`AGENT_KIT_*` / `AGENTIC_*` legacy aliases supported) |
| `OTTRIX_MODEL` / `OTTRIX_DEFAULT_MODEL` | Default model id |
| `OTTRIX_MAX_STEPS` | Max ReAct iterations (default `10`) |
| `OTTRIX_CONFIG_PATH` | Path to config JSON/YAML |
| `OTTRIX_TELEMETRY_ENABLED` | `true` / `false` |
| `OTTRIX_TELEMETRY_EXPORTER` | `console`, `memory`, `none`, `webhook` (Langfuse/Braintrust/OTel → `@ottrix/exporter-*`) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI (or compatible) API key |
| `OLLAMA_BASE_URL` | Ollama server (default `http://localhost:11434`) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Langfuse trace export |
| `BRAINTRUST_API_KEY`, `BRAINTRUST_PROJECT_NAME` | Braintrust trace export |

Merge order: **defaults → config file → environment → code overrides** (`loadConfig()`).

---

## Package exports

### `ottrix` core subpaths

| Import | Use case |
|--------|----------|
| `ottrix` | Main API — `Agent`, `createAgent`, evals, guardrails, orchestration |
| `ottrix/providers` | Provider classes, registry, fallback chain |
| `ottrix/tools` | Tools, MCP **client**, `ToolRegistry` |
| `ottrix/memory` | Memory modules + observational memory |
| `ottrix/orchestration` | Workflows, supervisor, DAG, `WorkflowLoader` |
| `ottrix/guardrails` | Middleware and validators |
| `ottrix/observability` | Logger, telemetry, replay |
| `ottrix/evals` | `evaluate()`, scorers, `EvalReporter` |
| `ottrix/exporters/webhook` | `WebhookExporter` (built-in) |
| `ottrix/types` | TypeScript types only |

### Standalone `@ottrix/*` packages

| Package | Use case |
|---------|----------|
| `@ottrix/mcp-server` | `serveMCP`, `MCPServer`, `ottrix-serve` CLI |
| `@ottrix/exporter-otel` | OTLP/HTTP OpenTelemetry export |
| `@ottrix/exporter-langfuse` | Langfuse trace export |
| `@ottrix/exporter-braintrust` | Braintrust trace export |
| `@ottrix/nestjs` | NestJS DI module, guards, interceptors |
| `@ottrix/express` / `@ottrix/fastify` / `@ottrix/hono` | HTTP server adapters |
| `@ottrix/vercel-ai` | Vercel AI SDK model & tool bridge |
| `@ottrix/langchain` | LangChain.js chat model & tools |
| `@ottrix/mastra` | Mastra model, tools, agent wrapper |

**ESM-first** (`"type": "module"`) with CommonJS builds (`.cjs`) for `require()`.

CLI: **`npx ottrix-serve`** — from `@ottrix/mcp-server`.

---

## Documentation & examples

| Resource | Link |
|----------|------|
| Module docs (code-accurate) | [docs/](docs/README.md) → `packages/*/docs/` |
| Runnable examples | [examples/http-agents/](examples/http-agents/) · [BACKEND_ADAPTERS.md](BACKEND_ADAPTERS.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Migration guide | [MIGRATION.md](MIGRATION.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

Run examples locally:

```bash
git clone https://github.com/ashwinpaulallen/ottrix.git
cd ottrix && npm install && npm run build
cd examples/simple-chatbot && npm install && npm start
```

| Example | Demonstrates |
|---------|----------------|
| [simple-chatbot](examples/simple-chatbot/) | CLI + streaming |
| [research-agent](examples/research-agent/) | Tools + ReAct loop |
| [multi-agent-pipeline](examples/multi-agent-pipeline/) | `SequentialWorkflow` |
| [mcp-integration](examples/mcp-integration/) | MCP tool discovery |
| [custom-provider](examples/custom-provider/) | Custom `BaseProvider` |

Generate API HTML (TypeDoc):

```bash
npm run docs
```

---

## Comparison

How **Ottrix** compares for **TypeScript / Node.js** agent projects:

| | Ottrix | LangChain | CrewAI | AutoGen |
|---|:---:|:---:|:---:|:---:|
| Primary language | **TypeScript** | Python / JS | Python | Python / .NET |
| Vendor SDK required | **No** (fetch) | Often | Varies | Varies |
| Install size | **Focused** | Large | Framework + roles | Chat orchestration |
| Multi-agent | Workflows + YAML | LangGraph, etc. | Crews | Group chat |
| MCP tools | **Built-in** client + server | Community | Varies | Varies |
| Evals | **Built-in** | Ecosystem | Varies | Varies |
| Best for | TS teams, minimal deps | Huge ecosystem | Rapid crew prototypes | Microsoft agent chat |

---

## Development

```bash
git clone https://github.com/ashwinpaulallen/ottrix.git
cd ottrix
npm install
npm test
npm run build
npm run prepublish:check
```

---

## License

[MIT](LICENSE) © [ashwinpaulallen](https://github.com/ashwinpaulallen)

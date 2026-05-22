# agentic-fabric

**TypeScript framework for building production LLM agents** — tool calling, memory, guardrails, observability, multi-agent workflows, and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) support. Vendor-neutral: Anthropic Claude, OpenAI-compatible APIs, and local Ollama via native `fetch` (no `@anthropic-ai/sdk` or `openai` npm package required).

[![npm version](https://img.shields.io/npm/v/agentic-fabric.svg)](https://www.npmjs.com/package/agentic-fabric)
[![CI](https://img.shields.io/github/actions/workflow/status/ashwinpaulallen/agent-fabric/test.yml?branch=main&logo=githubactions&label=CI)](https://github.com/ashwinpaulallen/agent-fabric/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/agentic-fabric)](https://www.npmjs.com/package/agentic-fabric)

> **Keywords:** AI agent · LLM framework · TypeScript · ReAct agent · tool use · MCP · multi-agent · Claude · GPT · Ollama · RAG memory · guardrails · observability

**Repository:** [github.com/ashwinpaulallen/agent-fabric](https://github.com/ashwinpaulallen/agent-fabric)

---

## What's New in v2

**agentic-fabric v2** adds structured output, Zod tools, provider fallbacks, MCP server hosting, observational memory, supervisor and DAG orchestration, evals, trace exporters, and **prompt injection protection enabled by default**.

| Feature | Import | Highlights |
|---------|--------|--------------|
| Structured output | `agentic-fabric` | Zod schemas on `agent.run()` with retries |
| Zod tools | `createTool`, `ZodTool` | Typed tool I/O, auto JSON Schema |
| Provider fallback | `agentic-fabric/providers` | `setFallbackChain()` + circuit breaker |
| MCP server | `agentic-fabric/mcp-server` | `serveMCP()` stdio/SSE + `agentic-serve` CLI |
| Observational memory | `agentic-fabric/memory` | LLM fact extraction + dedup |
| Supervisor | `createSupervisor` | Delegate to worker agents |
| DAG workflows | `DAGBuilder` | Parallel steps, suspend/resume |
| Evals | `agentic-fabric/evals` | `evaluate()` + scorers + reports |
| Trace exporters | `agentic-fabric/exporters/*` | Langfuse, Braintrust, webhook |
| Prompt injection | built-in | On by default — block / flag / sanitize |

See [CHANGELOG.md](CHANGELOG.md) for the full release notes.

---

## Table of contents

- [What's New in v2](#whats-new-in-v2)
- [Why agentic-fabric](#why-agentic-fabric)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Implementation examples](#implementation-examples)
- [Architecture](#architecture)
- [Features](#features)
- [Providers](#providers)
- [Configuration](#configuration)
- [Package exports](#package-exports)
- [Upgrading from v1](#upgrading-from-v1)
- [Documentation & examples](#documentation--examples)
- [Comparison](#comparison)
- [Development](#development)
- [License](#license)

---

## Why agentic-fabric

Use **agentic-fabric** when you need a **small, explicit TypeScript library** to run LLM agents in Node.js — not a heavy platform or Python stack.

| You get | Details |
|---------|---------|
| **ReAct agent loop** | Call the model, execute tools, repeat until a final answer or limit |
| **Tool calling** | JSON Schema tools with `FunctionTool` and `ToolRegistry` |
| **MCP integration** | Connect MCP servers over stdio or SSE and expose tools to agents |
| **Multi-agent workflows** | Sequential, parallel, router, and hierarchical pipelines |
| **Memory** | Working, semantic (RAG), and episodic memory modules |
| **Guardrails** | PII detection, token/cost budgets, content filters, human approval, **prompt injection (default)** |
| **Observability** | Structured logging, OpenTelemetry-style spans, run replay |
| **Zero vendor SDKs** | Built-in providers use HTTP APIs only — smaller installs, full control |

Ideal for: backend services, CLI agents, automation scripts, internal copilots, and TypeScript teams comparing alternatives to LangChain.js, CrewAI, or AutoGen.

---

## Requirements

- **Node.js** **20+** (`>=20`; CI tests 20, 22, and 24)
- An API key for **Anthropic** or **OpenAI**, or a local **[Ollama](https://ollama.com/)** server

---

## Installation

```bash
npm install agentic-fabric
```

```bash
# yarn
yarn add agentic-fabric

# pnpm
pnpm add agentic-fabric
```

**Optional** — full YAML workflow files (without it, a built-in YAML subset parser is used):

```bash
npm install js-yaml
```

Set your provider key (example for Anthropic):

```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

---

## Quick start

Minimal agent in under 10 lines:

```ts
import { createAgent } from 'agentic-fabric';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  systemPrompt: 'You are a helpful assistant.',
});

const { response } = await agent.run('What is 2 + 2?');
console.log(response);
```

One-liner helper:

```ts
import { quickAgent } from 'agentic-fabric';

const answer = await quickAgent('Summarize TypeScript in one sentence.', {
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
console.log(answer);
```

---

## Implementation examples

Copy-paste examples below match the **published API** (`v2.0.0`). Use `provider: 'openai'` or `'ollama'` by swapping config (see [Providers](#providers)).

### v2 feature examples

#### Structured output (Zod)

```ts
import { createAgent } from 'agentic-fabric';
import { z } from 'zod';

const schema = z.object({ name: z.string(), age: z.number() });
const agent = createAgent({ provider: 'anthropic' });
const { parsedOutput } = await agent.run('Introduce Ada Lovelace', { outputSchema: schema });
```

#### Zod tools

```ts
import { createAgent, createTool } from 'agentic-fabric';
import { z } from 'zod';

const weather = createTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempF: 72 }),
});

const agent = createAgent({ provider: 'anthropic', tools: [weather] });
```

#### Provider fallback chain

```ts
import { ProviderRegistry, createAnthropicProvider, createOpenAIProvider } from 'agentic-fabric/providers';

const registry = new ProviderRegistry()
  .register('anthropic', createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .setFallbackChain(['anthropic', 'openai']);

await registry.complete({ messages: [{ role: 'user', content: 'Hello' }] });
```

#### MCP server

```ts
import { serveMCP, ToolRegistry } from 'agentic-fabric/mcp-server';

const registry = new ToolRegistry();
registry.register(myTool);
await serveMCP({ name: 'my-tools', version: '1.0.0', toolRegistry: registry, transport: 'stdio' });
```

Or use the CLI: `npx agentic-serve --transport stdio`

#### Supervisor pattern

```ts
import { createSupervisor } from 'agentic-fabric';

const pipeline = createSupervisor({
  provider,
  workers: {
    researcher: { systemPrompt: 'You research.', description: 'Finds facts' },
    writer: { systemPrompt: 'You write.', description: 'Drafts prose' },
  },
});

await pipeline.run('Write a blog post about RLHF');
```

#### DAG workflows

```ts
import { DAGBuilder } from 'agentic-fabric';

const workflow = new DAGBuilder()
  .addStep('fetch', { name: 'Fetch', execute: async () => 'raw-data' })
  .addStep('analyze', { name: 'Analyze', execute: async () => ({ score: 10 }), dependencies: ['fetch'] })
  .build();

const result = await workflow.run('start');
console.log(result.finalOutput);
```

#### Workflow suspend / resume

```ts
import { DAGBuilder } from 'agentic-fabric';

const workflow = new DAGBuilder()
  .addStep('draft', { name: 'Draft', execute: async (input) => `Draft: ${input}` })
  .addStep('review', { name: 'Review', suspend: true, execute: async (input) => input, dependencies: ['draft'] })
  .build();

const suspended = await workflow.run('Quarterly update');
const done = await workflow.resume(suspended.suspendedState!, {
  workflowId: suspended.suspendedState!.workflowId,
  stepOutput: { approved: true, edits: 'Updated subject' },
});
```

#### Evals

```ts
import { evaluate, ExactMatchScorer, ContainsScorer } from 'agentic-fabric/evals';

const report = await evaluate({
  agent,
  dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
  scorers: [new ExactMatchScorer(), new ContainsScorer(['Paris'])],
});
console.log(report.aggregates.exact_match?.mean);
```

#### Observability (Langfuse)

```ts
import { getTelemetry, LangfuseExporter } from 'agentic-fabric';
// or: import { LangfuseExporter } from 'agentic-fabric/exporters/langfuse';

getTelemetry().setExporter(
  new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  }),
);
```

#### Prompt injection (enabled by default)

```ts
import { createAgent } from 'agentic-fabric';

// No extra config — injection attempts are blocked automatically
const agent = createAgent({ provider: 'anthropic' });

// Opt out or customize
const custom = createAgent({
  guardrails: { promptInjection: { mode: 'flag', strictness: 'high' } },
});
```

---

### 1. Streaming responses

Stream tokens to stdout (CLI, SSE, or UI):

```ts
import { createAgent } from 'agentic-fabric';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

for await (const event of agent.stream('Explain quantum entanglement briefly.')) {
  if (event.type === 'text') {
    process.stdout.write(String((event.data as { text: string }).text));
  }
  if (event.type === 'done') {
    process.stdout.write('\n');
  }
}
```

### 2. Agent with tools (function calling)

Register tools with JSON Schema; the agent runs a **ReAct loop** (model → tool calls → model → answer):

```ts
import { createAgent, FunctionTool } from 'agentic-fabric';

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  execute: async ({ city }) => ({
    city: String(city),
    tempF: 72,
    condition: 'sunny',
  }),
});

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  tools: [weatherTool],
  systemPrompt: 'Use tools when needed, then answer concisely.',
});

const result = await agent.run('What is the weather in Paris?');
console.log(result.response);
console.log('Steps:', result.steps.length, '| Stop:', result.metadata.stopReason);
```

### 3. Custom agent (full control)

Use `new Agent()` when you need a custom provider instance or `ToolRegistry`:

```ts
import { Agent, ToolRegistry, FunctionTool } from 'agentic-fabric';
import { createAnthropicProvider } from 'agentic-fabric/providers';

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

### 4. Multi-agent pipeline (sequential workflow)

Chain specialized agents — researcher → writer:

```ts
import { Agent, SequentialWorkflow } from 'agentic-fabric';
import { createAnthropicProvider } from 'agentic-fabric/providers';

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const researcher = new Agent({
  name: 'researcher',
  provider,
  systemPrompt: 'Gather concise research notes.',
});

const writer = new Agent({
  name: 'writer',
  provider,
  systemPrompt: 'Write a short, clear summary.',
});

const pipeline = new SequentialWorkflow([
  {
    agent: researcher,
    inputMapper: ({ originalInput }) => `Research: ${originalInput}`,
  },
  {
    agent: writer,
    inputMapper: (_ctx, prev) =>
      `Write a summary from these notes:\n${prev?.response ?? ''}`,
  },
]);

const output = await pipeline.run('Benefits of multi-agent AI systems');
console.log(output.finalResult.response);
```

### 5. OpenAI-compatible API (GPT, Azure, proxies)

Works with any OpenAI Chat Completions-compatible endpoint:

```ts
import { createAgent } from 'agentic-fabric';

const agent = createAgent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1', // or your proxy URL
});

const { response } = await agent.run('Hello!');
```

### 6. Local models with Ollama

No cloud API key required:

```bash
ollama serve
ollama pull llama3.1
```

```ts
import { createAgent } from 'agentic-fabric';

const agent = createAgent({
  provider: 'ollama',
  model: 'llama3.1',
  baseUrl: 'http://localhost:11434',
});

const { response } = await agent.run('Hello from local LLM');
```

### 7. Guardrails and budgets

Disable defaults or configure PII, steps, and token limits:

```ts
import { createAgent } from 'agentic-fabric';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  maxSteps: 5,
  guardrails: {
    piiDetection: true,
    budget: { maxSteps: 5, maxTokenBudget: 8_000 },
  },
});
```

### 8. Environment-based configuration

Load `.agenticrc.json` and `AGENTIC_*` variables:

```ts
import { loadConfig, createAgent } from 'agentic-fabric';

const { config } = loadConfig();
const agent = createAgent({
  provider: config.defaultProvider,
  model: config.defaultModel,
});
```

Example `.agenticrc.json`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "maxSteps": 10,
  "telemetry": { "enabled": true, "exporter": "console" }
}
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│              Your application (API, CLI, workers, MCP clients)       │
├──────────────────────────────────────────────────────────────────────┤
│  Orchestration — Sequential · Parallel · Router · Supervisor · DAG │
│                  YAML loader · suspend/resume                        │
├──────────────────────────────────────────────────────────────────────┤
│  Agent — ReAct loop · structured output (Zod) · Planner · Reflector  │
├────────────┬─────────────┬──────────────┬─────────────┬────────────┤
│   Tools    │   Memory    │  Guardrails  │ Observability│   Evals    │
│  + MCP     │  RAG · epis.│ PII · budget │ Langfuse ·  │  Scorers · │
│  client &  │  observational│ injection* │ Braintrust  │  reports   │
│  server    │             │  (default)   │ webhook     │            │
├────────────┴─────────────┴──────────────┴─────────────┴────────────┤
│  Providers — Anthropic · OpenAI · Ollama · fallback chain · breaker  │
├──────────────────────────────────────────────────────────────────────┤
│  Config — loadConfig() · .agenticrc · AGENTIC_* env vars             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Features

| Module | What it does |
|--------|----------------|
| **[Agent](docs/agent.md)** | ReAct loop, `run()` and `stream()`, structured output (Zod), planners |
| **[Providers](docs/providers.md)** | Claude, GPT, Ollama; retries; fallback chain; circuit breaker |
| **[Tools](docs/tools.md)** | `FunctionTool`, `createTool` (Zod), **MCP** client + server |
| **[Memory](docs/memory.md)** | Working buffer, semantic RAG, episodic recall, observational memory |
| **[Guardrails](docs/guardrails.md)** | PII, budgets, filters, human-in-the-loop, **prompt injection (default)** |
| **[Observability](docs/observability.md)** | Logger, telemetry spans, Langfuse/Braintrust/webhook exporters |
| **[Orchestration](docs/orchestration.md)** | Sequential, supervisor, DAG workflows + YAML loader |
| **[Evals](docs/evals.md)** | `evaluate()`, scorers, CSV/Markdown reports |
| **[Configuration](docs/configuration.md)** | `createAgent`, env vars, layered config files |

Full implementation docs: **[docs/README.md](docs/README.md)**

---

## Providers

| Provider | `createAgent` | API key env | Default model |
|----------|---------------|-------------|---------------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI-compatible | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` |
| Ollama (local) | `provider: 'ollama'` | none | `llama3.1` |

Extend any HTTP API with [`BaseProvider`](docs/providers.md):

```ts
import { BaseProvider } from 'agentic-fabric/providers';
// Implement _rawComplete, _rawStream, _countTokens
```

---

## Configuration

Common environment variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI (or compatible) API key |
| `OLLAMA_BASE_URL` | Ollama server (default `http://localhost:11434`) |
| `AGENTIC_PROVIDER` | Default provider: `anthropic`, `openai`, `ollama` |
| `AGENTIC_MODEL` | Default model id |
| `AGENTIC_MAX_STEPS` | Max ReAct iterations (default `10`) |
| `AGENTIC_CONFIG_PATH` | Path to `.agenticrc` JSON/YAML |
| `AGENTIC_TELEMETRY_ENABLED` | `true` / `false` |

Merge order: **defaults → config file → environment → code overrides** (`loadConfig()`).

---

## Package exports

Tree-shakeable subpath imports:

| Import | Use case |
|--------|----------|
| `agentic-fabric` | Main API — `Agent`, `createAgent`, evals, guardrails, orchestration |
| `agentic-fabric/providers` | Provider classes, registry, fallback chain |
| `agentic-fabric/tools` | Tools, MCP client, `ToolRegistry` |
| `agentic-fabric/mcp-server` | `MCPServer`, `serveMCP` (lightweight MCP hosting) |
| `agentic-fabric/memory` | Memory modules + observational memory |
| `agentic-fabric/orchestration` | Workflows, supervisor, DAG, `WorkflowLoader` |
| `agentic-fabric/guardrails` | Middleware and validators |
| `agentic-fabric/observability` | Logger, telemetry, replay |
| `agentic-fabric/evals` | `evaluate()`, scorers, `EvalReporter` |
| `agentic-fabric/exporters/langfuse` | Langfuse trace exporter (also Braintrust, webhook) |
| `agentic-fabric/types` | TypeScript types only |

**ESM-first** (`"type": "module"`) with CommonJS builds (`.cjs`) for `require()`.

---

## Upgrading from v1

1. **Bump the package:** `npm install agentic-fabric@2`
2. **Prompt injection is now on by default.** Suspicious inputs are blocked before reaching the LLM. Opt out with `guardrails: { promptInjection: false }` if needed.
3. **New subpath imports** are available for tree-shaking (`agentic-fabric/evals`, `agentic-fabric/mcp-server`, `agentic-fabric/exporters/langfuse`).
4. **Structured output** uses Zod via `outputSchema` on `agent.run()` — install the optional `zod` peer dependency.
5. **Breaking changes:** none intended for v1 APIs; new features are additive. See [CHANGELOG.md](CHANGELOG.md) and [MIGRATION.md](MIGRATION.md) for details.

---

## Documentation & examples

| Resource | Link |
|----------|------|
| Module docs (code-accurate) | [docs/](docs/README.md) |
| Runnable examples | [examples/](examples/README.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Migration guide | [MIGRATION.md](MIGRATION.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

Run examples locally:

```bash
git clone https://github.com/ashwinpaulallen/agent-fabric.git
cd agent-fabric && npm install && npm run build
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

How **agentic-fabric** compares for **TypeScript / Node.js** agent projects:

| | agentic-fabric | LangChain | CrewAI | AutoGen |
|---|:---:|:---:|:---:|:---:|
| Primary language | **TypeScript** | Python / JS | Python | Python / .NET |
| Vendor SDK required | **No** (fetch) | Often | Varies | Varies |
| Install size | **Focused** | Large | Framework + roles | Chat orchestration |
| Multi-agent | Workflows + YAML | LangGraph, etc. | Crews | Group chat |
| MCP tools | **Built-in** | Community | Varies | Varies |
| Best for | TS teams, minimal deps | Huge ecosystem | Rapid crew prototypes | Microsoft agent chat |

---

## Development

```bash
git clone https://github.com/ashwinpaulallen/agent-fabric.git
cd agent-fabric
npm install
npm test
npm run build
npm run prepublish:check
```

---

## License

[MIT](LICENSE) © [ashwinpaulallen](https://github.com/ashwinpaulallen)

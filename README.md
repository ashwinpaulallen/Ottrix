# agentic-fabric

**TypeScript framework for building production LLM agents** — ReAct loop, structured output, tool calling, memory, guardrails, observability, evals, multi-agent workflows, and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) client and server support. Vendor-neutral: Anthropic Claude, OpenAI-compatible APIs, and local Ollama via native `fetch` (no `@anthropic-ai/sdk` or `openai` npm package required).

[![npm version](https://img.shields.io/npm/v/agentic-fabric.svg)](https://www.npmjs.com/package/agentic-fabric)
[![CI](https://img.shields.io/github/actions/workflow/status/ashwinpaulallen/agent-fabric/test.yml?branch=main&logo=githubactions&label=CI)](https://github.com/ashwinpaulallen/agent-fabric/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/agentic-fabric)](https://www.npmjs.com/package/agentic-fabric)

> **Keywords:** AI agent · LLM framework · TypeScript · ReAct · tool use · MCP · multi-agent · structured output · evals · Claude · GPT · Ollama · guardrails · observability

**Repository:** [github.com/ashwinpaulallen/agent-fabric](https://github.com/ashwinpaulallen/agent-fabric)

---

## Table of contents

- [Why agentic-fabric](#why-agentic-fabric)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
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

## Why agentic-fabric

Use **agentic-fabric** when you need a **small, explicit TypeScript library** to run LLM agents in Node.js — not a heavy platform or Python stack.

| You get | Details |
|---------|---------|
| **ReAct agent loop** | Call the model, execute tools, repeat until a final answer or limit |
| **Structured output** | Validate final responses with Zod schemas and automatic retries |
| **Tool calling** | JSON Schema (`FunctionTool`) or Zod (`createTool`) with typed I/O |
| **MCP** | Connect to external MCP servers **and** host your own via `serveMCP` / `agentic-serve` |
| **Multi-agent workflows** | Sequential, parallel, router, hierarchical, **supervisor**, and **DAG** (with suspend/resume) |
| **Memory** | Working, semantic (RAG), episodic, and **observational** (LLM fact extraction) |
| **Guardrails** | PII, budgets, content filters, human approval, **prompt injection protection (on by default)** |
| **Observability** | Spans, metrics, run replay, and exporters for **Langfuse**, **Braintrust**, and webhooks |
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
npm install agentic-fabric
```

```bash
# yarn
yarn add agentic-fabric

# pnpm
pnpm add agentic-fabric
```

**Optional peer dependencies:**

```bash
# Structured output, Zod tools, schema-based eval scorers
npm install zod

# Full YAML workflow files (built-in subset parser works without this)
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

Prompt injection protection, PII detection, and step/token budgets are **enabled by default** — no extra configuration required.

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

## Feature examples

### Structured output (Zod)

```ts
import { createAgent } from 'agentic-fabric';
import { z } from 'zod';

const schema = z.object({ name: z.string(), age: z.number() });
const agent = createAgent({ provider: 'anthropic' });
const { parsedOutput } = await agent.run('Introduce Ada Lovelace', { outputSchema: schema });
```

### Zod tools

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

### Provider fallback chain

```ts
import { ProviderRegistry, createAnthropicProvider, createOpenAIProvider } from 'agentic-fabric/providers';

const registry = new ProviderRegistry()
  .register('anthropic', createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .setFallbackChain(['anthropic', 'openai']);

await registry.complete({ messages: [{ role: 'user', content: 'Hello' }] });
```

### MCP server

Expose tools (and optionally an agent) to external MCP clients:

```ts
import { serveMCP, ToolRegistry } from 'agentic-fabric/mcp-server';

const registry = new ToolRegistry();
registry.register(myTool);
await serveMCP({ name: 'my-tools', version: '1.0.0', toolRegistry: registry, transport: 'stdio' });
```

CLI: `npx agentic-serve --transport stdio`

### Supervisor pattern

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

### DAG workflows with suspend / resume

```ts
import { DAGBuilder } from 'agentic-fabric';

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
import { evaluate, ExactMatchScorer, ContainsScorer } from 'agentic-fabric/evals';

const report = await evaluate({
  agent,
  dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
  scorers: [new ExactMatchScorer(), new ContainsScorer(['Paris'])],
});
console.log(report.aggregates.exact_match?.mean);
```

### Observability (Langfuse)

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

### Prompt injection guardrails

Enabled automatically on every `createAgent()` call. Customize or opt out:

```ts
import { createAgent } from 'agentic-fabric';

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
import { createAgent } from 'agentic-fabric';

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
import { createAgent, FunctionTool } from 'agentic-fabric';

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

### Multi-agent pipeline (sequential)

```ts
import { Agent, SequentialWorkflow } from 'agentic-fabric';
import { createAnthropicProvider } from 'agentic-fabric/providers';

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
import { createAgent } from 'agentic-fabric';

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
import { createAgent } from 'agentic-fabric';

const agent = createAgent({
  provider: 'ollama',
  model: 'llama3.1',
  baseUrl: 'http://localhost:11434',
});
```

### Guardrails and budgets

```ts
import { createAgent } from 'agentic-fabric';

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
import { loadConfig, createAgent } from 'agentic-fabric';

const { config } = loadConfig();
const agent = createAgent({ provider: config.defaultProvider, model: config.defaultModel });
```

Example `.agenticrc.json`:

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
│  + MCP     │  RAG · epis.│ PII · budget │ Langfuse ·  │  Scorers · │
│  client &  │  observational│ injection  │ Braintrust  │  reports   │
│  server    │             │  (default)   │ webhook     │            │
├────────────┴─────────────┴──────────────┴─────────────┴────────────┤
│  Providers — Anthropic · OpenAI · Ollama · fallback chain · breaker  │
├──────────────────────────────────────────────────────────────────────┤
│  Config — loadConfig() · .agenticrc · AGENTIC_* env vars             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Module documentation

Implementation-accurate guides under [`docs/`](docs/README.md):

| Module | Document | Topics |
|--------|----------|--------|
| Agent | [docs/agent.md](docs/agent.md) | ReAct loop, structured output, planner, reflector |
| Providers | [docs/providers.md](docs/providers.md) | Anthropic, OpenAI, Ollama, fallback chain, circuit breaker |
| Tools | [docs/tools.md](docs/tools.md) | `FunctionTool`, `createTool`, MCP client/server, tool approval |
| Memory | [docs/memory.md](docs/memory.md) | Working, semantic, episodic, observational memory |
| Guardrails | [docs/guardrails.md](docs/guardrails.md) | Middleware, PII, budgets, prompt injection |
| Observability | [docs/observability.md](docs/observability.md) | Telemetry, trace exporters, retention, replay |
| Orchestration | [docs/orchestration.md](docs/orchestration.md) | Workflows, supervisor, DAG, YAML loader |
| Evals | [docs/evals.md](docs/evals.md) | `evaluate()`, scorers, reports |
| Configuration | [docs/configuration.md](docs/configuration.md) | `loadConfig`, env vars, `createAgent` |
| Overview | [docs/overview.md](docs/overview.md) | Package layout, subpath exports |

Release history: [CHANGELOG.md](CHANGELOG.md) · Upgrade notes: [MIGRATION.md](MIGRATION.md)

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
| `AGENTIC_TELEMETRY_EXPORTER` | `console`, `memory`, `none`, `langfuse`, `braintrust`, `webhook` |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Langfuse trace export |
| `BRAINTRUST_API_KEY`, `BRAINTRUST_PROJECT_NAME` | Braintrust trace export |

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

CLI: **`agentic-serve`** — host an MCP server from the command line.

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
| MCP tools | **Built-in** client + server | Community | Varies | Varies |
| Evals | **Built-in** | Ecosystem | Varies | Varies |
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

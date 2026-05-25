# ottrix

**TypeScript framework for production LLM agents** — the **`ottrix`** npm package is the core of the [Ottrix monorepo](https://github.com/ashwinpaulallen/ottrix). ReAct loop, structured output, tool calling, memory, guardrails, observability, evals, multi-agent workflows, and [MCP](https://modelcontextprotocol.io/) **client** support. Vendor-neutral: Anthropic Claude, OpenAI-compatible APIs, and Ollama via native `fetch` (no vendor SDK required).

**All packages:** [docs/README.md](../../docs/README.md)

[![npm version](https://img.shields.io/npm/v/ottrix.svg)](https://www.npmjs.com/package/ottrix)
[![Node](https://img.shields.io/node/v/ottrix)](https://www.npmjs.com/package/ottrix)

**Version:** 2.1.0 · **Node:** ≥20 · **License:** MIT

Full project docs: [github.com/ashwinpaulallen/ottrix](https://github.com/ashwinpaulallen/ottrix) · **Core module guides:** [docs/README.md](docs/README.md) · Monorepo index: [../../docs/README.md](../../docs/README.md)

---

## Install

```bash
npm install ottrix
```

**Optional peers** (install when you need them):

```bash
npm install zod          # structured output, Zod tools, schema eval scorers
npm install js-yaml      # full YAML workflow files
npm install ioredis pg   # Redis/Postgres DAG state stores
```

**Standalone packages** (install when you need them):

```bash
npm install @ottrix/exporter-langfuse   # Langfuse trace export
npm install @ottrix/exporter-braintrust # Braintrust trace export
npm install @ottrix/exporter-otel       # OpenTelemetry OTLP export
npm install @ottrix/mcp-server          # MCP server hosting + ottrix-serve CLI
```

```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

---

## Quick start

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

Guardrails (prompt injection, PII, budgets) are **on by default**. One-liner helper:

```ts
import { quickAgent } from 'ottrix';

const answer = await quickAgent('Summarize TypeScript in one sentence.', {
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

---

## Subpath exports

| Import | Purpose | Key APIs |
|--------|---------|----------|
| `ottrix` | Main barrel | `createAgent`, `Agent`, `runWith`, `AuditEmitter`, orchestration, guardrails |
| `ottrix/agent` | Agent internals | `Agent`, planner, reflector, structured output |
| `ottrix/providers` | LLM backends | `createAnthropicProvider`, `ProviderRegistry`, `CircuitBreaker` |
| `ottrix/tools` | Tool calling | `FunctionTool`, `createTool`, `ToolRegistry`, `MCPClient` |
| `ottrix/memory` | Agent memory | `WorkingMemory`, `SemanticMemory`, `ObservationalMemory` |
| `ottrix/orchestration` | Multi-agent | `SequentialWorkflow`, `SupervisorWorkflow`, `DAGBuilder` |
| `ottrix/guardrails` | Safety | `createGuardrails`, `configureBudgets`, `PromptInjectionGuardrail` |
| `ottrix/observability` | Telemetry | `getTelemetry`, `getLogger`, replay utilities |
| `ottrix/evals` | Evaluation | `evaluate`, `EvalRunner`, scorers, `EvalReporter` |
| `ottrix/exporters/webhook` | Webhooks | `WebhookExporter` |
| `ottrix/types` | Types only | Shared TypeScript contracts |

| Standalone package | Purpose | Key APIs |
|--------------------|---------|----------|
| `@ottrix/mcp-server` | MCP hosting | `serveMCP`, `MCPServer`, `ottrix-serve` CLI |
| `@ottrix/exporter-otel` | OpenTelemetry | `OtelExporter`, `createOtelExporter` |
| `@ottrix/exporter-langfuse` | Langfuse | `LangfuseExporter` |
| `@ottrix/exporter-braintrust` | Braintrust | `BraintrustExporter` |

**CLI:** `npx ottrix-serve --transport stdio` — requires `@ottrix/mcp-server`.

---

## Usage by module

### Agent and structured output

```ts
import { createAgent } from 'ottrix';
import { z } from 'zod';

const schema = z.object({ name: z.string(), age: z.number() });
const agent = createAgent({ provider: 'anthropic' });

const { parsedOutput } = await agent.run('Introduce Ada Lovelace', { outputSchema: schema });
```

Streaming:

```ts
for await (const event of agent.stream('Explain quantum entanglement briefly.')) {
  if (event.type === 'text') process.stdout.write(String((event.data as { text: string }).text));
}
```

### Tools

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

### Providers and fallback

```ts
import { ProviderRegistry, createAnthropicProvider, createOpenAIProvider } from 'ottrix/providers';

const registry = new ProviderRegistry()
  .register('anthropic', createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .setFallbackChain(['anthropic', 'openai']);
```

| Provider | `createAgent` | API key env | Default model |
|----------|---------------|-------------|---------------|
| Anthropic | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI-compatible | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` |
| Ollama | `provider: 'ollama'` | none | `llama3.1` |

### Run context

Propagate `runId`, `orgId`, and custom fields through agent runs without threading parameters:

```ts
import { createAgent, runWith } from 'ottrix';

await runWith({ runId: 'req-42', orgId: 'acme-corp' }, () =>
  agent.run('Summarize Q1 earnings'),
);
```

### MCP server

Install `@ottrix/mcp-server` — the MCP **client** (`MCPClient`) remains in core.

```ts
import { serveMCP } from '@ottrix/mcp-server';
import { ToolRegistry } from 'ottrix';

const registry = new ToolRegistry();
registry.register(myTool);
await serveMCP({ name: 'my-tools', version: '2.0.0', toolRegistry: registry, transport: 'stdio' });
```

### Workflows

```ts
import { createSupervisor, DAGBuilder } from 'ottrix';

const supervisor = createSupervisor({
  provider,
  workers: {
    researcher: { systemPrompt: 'You research.', description: 'Finds facts' },
    writer: { systemPrompt: 'You write.', description: 'Drafts prose' },
  },
});

const dag = new DAGBuilder()
  .addStep('draft', { name: 'Draft', execute: async (input) => `Draft: ${input}` })
  .addStep('review', { name: 'Review', suspend: true, execute: async (i) => i, dependencies: ['draft'] })
  .build();
```

### Observability

```ts
import { getTelemetry } from 'ottrix';
import { LangfuseExporter } from '@ottrix/exporter-langfuse';
import { createOtelExporter } from '@ottrix/exporter-otel';

getTelemetry().setExporter(new LangfuseExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
}));

getTelemetry().addExporter(createOtelExporter('jaeger', { serviceName: 'my-agent' }));
```

### Evals

```ts
import { evaluate, ExactMatchScorer } from 'ottrix/evals';

const report = await evaluate({
  agent,
  dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
  scorers: [new ExactMatchScorer()],
});
```

### Audit trail

```ts
import { AuditEmitter, FileSink, HmacSigner, useAudit } from 'ottrix';

useAudit(new AuditEmitter({
  sink: new FileSink({ path: './audit.jsonl' }),
  signer: new HmacSigner({ secret: process.env.AUDIT_SECRET! }),
  redact: ['args.token', 'args.password'],
}));
```

---

## Configuration

Environment variables (legacy `AGENT_KIT_*` / `AGENTIC_*` aliases still supported):

| Variable | Description |
|----------|-------------|
| `OTTRIX_PROVIDER` | Default provider (`anthropic`, `openai`, `ollama`) |
| `OTTRIX_MODEL` | Default model id |
| `OTTRIX_MAX_STEPS` | Max ReAct iterations (default `10`) |
| `OTTRIX_CONFIG_PATH` | Path to `.ottrixrc.json` |
| `OTTRIX_TELEMETRY_EXPORTER` | `console`, `webhook`, `memory`, `none` (Langfuse/Braintrust/OTel → standalone packages) |

```ts
import { loadConfig, createAgent } from 'ottrix';

const { config } = loadConfig();
const agent = createAgent({ provider: config.defaultProvider, model: config.defaultModel });
```

---

## Framework adapters

Use **`ottrix`** directly in any Node.js HTTP framework, or install a first-party adapter:

| Adapter | Package | Status |
|---------|---------|--------|
| NestJS | `@ottrix/nestjs` | Published — [docs](../nestjs/docs/) |
| Express | `@ottrix/express` | Implemented — [README](../express/README.md) · [docs](../express/docs/) |
| Fastify | `@ottrix/fastify` | Implemented — [README](../fastify/README.md) · [docs](../fastify/docs/) |
| Hono | `@ottrix/hono` | Implemented — [README](../hono/README.md) · [docs](../hono/docs/) |
| Next.js | `@ottrix/nextjs` | Published — [README](../nextjs/README.md) |

---

## Version constant

```ts
import { OTTRIX_VERSION } from 'ottrix';
// '2.1.0'
```

---

## Links

- [Core module documentation](docs/README.md)
- [Monorepo package index](../../docs/README.md)
- [Root README](../../README.md)
- [Migration guide](../../MIGRATION.md) — v2.1 exporter & MCP server moves
- [NestJS adapter](../nestjs/README.md) · [MCP server](../mcp-server/README.md)
- [Trace exporters](../exporter-otel/README.md) · [Framework bridges](../vercel-ai/README.md)
- [Examples](../../examples/) · [Changelog](../../CHANGELOG.md)

[MIT](https://github.com/ashwinpaulallen/ottrix/blob/main/LICENSE) © [ashwinpaulallen](https://github.com/ashwinpaulallen)

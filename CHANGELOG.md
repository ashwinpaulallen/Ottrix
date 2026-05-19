# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No changes yet._

## [1.0.0] - 2026-05-19

### Added

#### Structured output

Validate LLM responses against Zod schemas with automatic retries:

```ts
import { createAgent } from 'ottrix';
import { z } from 'zod';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
});

const agent = createAgent({ provider: 'anthropic' });
const { parsedOutput } = await agent.run('Introduce Ada Lovelace', {
  outputSchema: personSchema,
});
```

#### Zod tools

Define tools with Zod input/output schemas via `createTool`:

```ts
import { createTool } from 'ottrix';
import { z } from 'zod';

const weather = createTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempF: 72 }),
});
```

#### Provider fallback & circuit breaker

`ProviderRegistry.setFallbackChain()` with per-provider circuit breakers:

```ts
import { ProviderRegistry, createAnthropicProvider, createOpenAIProvider } from 'ottrix/providers';

const registry = new ProviderRegistry()
  .register('anthropic', createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .setFallbackChain(['anthropic', 'openai']);

const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });
```

#### MCP server

Expose tools (and optionally an agent) to external MCP clients:

```ts
import { serveMCP, ToolRegistry, FunctionTool } from 'ottrix/mcp-server';

const registry = new ToolRegistry();
registry.register(myTool);
await serveMCP({ name: 'my-tools', version: '1.0.0', toolRegistry: registry, transport: 'stdio' });
```

CLI: `npx ottrix-serve --help`

#### Observational memory

LLM-driven fact extraction with deduplication and contradiction handling:

```ts
import { ObservationalMemory, InMemoryObservationStore } from 'ottrix/memory';

const memory = new ObservationalMemory({
  provider,
  store: new InMemoryObservationStore(),
});
await memory.observe('User prefers metric units.');
```

#### Supervisor pattern

Delegate tasks to specialized worker agents:

```ts
import { createSupervisor } from 'ottrix';

const pipeline = createSupervisor({
  provider,
  workers: {
    researcher: { systemPrompt: '...', description: 'Finds facts' },
    writer: { systemPrompt: '...', description: 'Writes prose' },
  },
});

const result = await pipeline.run('Write a blog post about RLHF');
```

#### DAG workflows

Build dependency graphs with parallelism, retries, timeouts, and human-in-the-loop suspend/resume:

```ts
import { DAGBuilder } from 'ottrix';

const workflow = new DAGBuilder()
  .addStep('draft', { name: 'Draft', execute: async (input) => `Draft: ${input}` })
  .addStep('review', { name: 'Review', suspend: true, execute: async (input) => input, dependencies: ['draft'] })
  .build();

const suspended = await workflow.run('Quarterly update');
const done = await workflow.resume(suspended.suspendedState!, {
  workflowId: suspended.suspendedState!.workflowId,
  stepOutput: { approved: true },
});
```

#### Evals framework

Run datasets against agents with pluggable scorers:

```ts
import { evaluate, ExactMatchScorer, ContainsScorer } from 'ottrix/evals';

const report = await evaluate({
  agent,
  dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
  scorers: [new ExactMatchScorer(), new ContainsScorer(['Paris'])],
});
console.log(report.aggregates);
```

#### Observability exporters

Export OpenTelemetry-style traces to Langfuse, Braintrust, webhooks, or multiple backends:

```ts
import { getTelemetry, LangfuseExporter } from 'ottrix';

getTelemetry().setExporter(
  new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  }),
);
```

Subpath: `import { LangfuseExporter } from 'ottrix/exporters/langfuse'`

#### Prompt injection guardrails

Enabled by default on every agent — blocks, flags, or sanitizes injection attempts:

```ts
import { createAgent } from 'ottrix';

// Active by default — no extra config required
const agent = createAgent({ provider: 'anthropic' });

// Customize or opt out
const strict = createAgent({
  guardrails: { promptInjection: { strictness: 'high' } },
});
const open = createAgent({ guardrails: { promptInjection: false } });
```

### Changed

- Package renamed from **`agentic-fabric`** to **`ottrix`** (`ottrix-serve` CLI, `OTTRIX_*` env vars, `.ottrixrc.*` config files; legacy `AGENT_KIT_*`, `AGENTIC_*`, and `.agentkitrc.*` / `.agenticrc.*` names still supported)
- Initial public release **1.0.0** with expanded main entry exports and subpaths: `./evals`, `./mcp-server`, `./exporters/*`
- `createGuardrails()` includes `PromptInjectionGuardrail` unless `promptInjection: false`

### Package

- New keywords: `eval`, `dag`, `supervisor`, `structured-output`
- `ottrix-serve` CLI bin for MCP server hosting

### Fixed

- Anthropic/OpenAI missing API key throws `ProviderError` with `code: 'auth'`
- MCP JSON-RPC parse failures throw `MCPProtocolError` instead of generic `Error`

[1.0.0]: https://github.com/ashwinpaulallen/ottrix/releases/tag/v1.0.0

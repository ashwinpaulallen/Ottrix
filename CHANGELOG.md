# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No changes yet._

## [2.0.0] - 2026-05-19

### Added

#### Structured output

Validate LLM responses against Zod schemas with automatic retries:

```ts
import { createAgent } from 'agentic-fabric';
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
import { createTool } from 'agentic-fabric';
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
import { ProviderRegistry, createAnthropicProvider, createOpenAIProvider } from 'agentic-fabric/providers';

const registry = new ProviderRegistry()
  .register('anthropic', createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .setFallbackChain(['anthropic', 'openai']);

const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });
```

#### MCP server

Expose tools (and optionally an agent) to external MCP clients:

```ts
import { serveMCP, ToolRegistry, FunctionTool } from 'agentic-fabric/mcp-server';

const registry = new ToolRegistry();
registry.register(myTool);
await serveMCP({ name: 'my-tools', version: '1.0.0', toolRegistry: registry, transport: 'stdio' });
```

CLI: `npx agentic-serve --help`

#### Observational memory

LLM-driven fact extraction with deduplication and contradiction handling:

```ts
import { ObservationalMemory, InMemoryObservationStore } from 'agentic-fabric/memory';

const memory = new ObservationalMemory({
  provider,
  store: new InMemoryObservationStore(),
});
await memory.observe('User prefers metric units.');
```

#### Supervisor pattern

Delegate tasks to specialized worker agents:

```ts
import { createSupervisor } from 'agentic-fabric';

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
import { DAGBuilder } from 'agentic-fabric';

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
import { evaluate, ExactMatchScorer, ContainsScorer } from 'agentic-fabric/evals';

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
import { getTelemetry, LangfuseExporter } from 'agentic-fabric';

getTelemetry().setExporter(
  new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  }),
);
```

Subpath: `import { LangfuseExporter } from 'agentic-fabric/exporters/langfuse'`

#### Prompt injection guardrails

Enabled by default on every agent — blocks, flags, or sanitizes injection attempts:

```ts
import { createAgent } from 'agentic-fabric';

// Active by default — no extra config required
const agent = createAgent({ provider: 'anthropic' });

// Customize or opt out
const strict = createAgent({
  guardrails: { promptInjection: { strictness: 'high' } },
});
const open = createAgent({ guardrails: { promptInjection: false } });
```

### Changed

- Version bumped to **2.0.0** with expanded main entry exports and new subpaths: `./evals`, `./mcp-server`, `./exporters/*`
- `createGuardrails()` includes `PromptInjectionGuardrail` unless `promptInjection: false`

### Package

- New keywords: `eval`, `dag`, `supervisor`, `structured-output`
- `agentic-serve` CLI bin for MCP server hosting

## [1.0.0] - 2026-05-19

### Added

- Initial public release as **agentic-fabric** on npm
- **Agent** — ReAct loop with streaming, planners, reflectors, and step limits
- **Providers** — Anthropic, OpenAI-compatible, and Ollama via native `fetch` (no vendor SDKs bundled)
- **Tools** — `FunctionTool`, `BaseTool`, `ToolRegistry`, `ToolNotFoundError`, and MCP client/provider (stdio + SSE)
- **Memory** — working, semantic (RAG), and episodic memory modules
- **Guardrails** — middleware for PII, budgets, content filters, human approval, and audit logging
- **Observability** — structured logging, telemetry spans/metrics, and run replay
- **Orchestration** — sequential, parallel, router, and hierarchical workflows; YAML/JSON loader
- **Configuration** — `loadConfig()`, `.agenticrc.*`, and `AGENTIC_*` environment variables
- **Convenience API** — `createAgent()`, `quickAgent()`
- Subpath exports: `types`, `providers`, `tools`, `memory`, `orchestration`, `guardrails`, `observability`, `agent`
- Runnable examples under `examples/`
- Integration test suite and GitHub Actions CI

### Fixed

- Anthropic/OpenAI missing API key throws `ProviderError` with `code: 'auth'`
- MCP JSON-RPC parse failures throw `MCPProtocolError` instead of generic `Error`

[2.0.0]: https://github.com/ashwinpaulallen/agent-fabric/releases/tag/v2.0.0
[1.0.0]: https://github.com/ashwinpaulallen/agent-fabric/releases/tag/v1.0.0

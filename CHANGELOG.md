# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-05-23

### Added

#### Run context (AsyncLocalStorage)

Propagate `runId`, `stepId`, `agentName`, and custom fields (`orgId`, etc.) through agent runs, workflows, budgets, audit, and OTEL export without manual parameter threading.

```ts
import { runWith } from 'ottrix';

await runWith({ runId: 'req-42', orgId: 'acme' }, () => agent.run('Hello'));
```

See [docs/context.md](docs/context.md).

#### Tool safety envelope

Tools declare safety metadata: `sideEffect`, `idempotent`, `requiresApproval`, `requiresSandbox`, and optional `audit` field filters. `ToolRegistry` enforces sandbox and approval gates for destructive tools and emits policy audit events.

See [docs/tools.md](docs/tools.md#tool-safety-envelope).

#### Idempotent tool execution

Mark tools `idempotent: true` and configure an `IdempotencyStore` on `ToolRegistry` to deduplicate concurrent and retried executions.

See [docs/tools.md](docs/tools.md#idempotent-tool-execution).

#### Pluggable workflow state stores

Persist suspended DAG workflow state to **Redis** (`ioredis`) or **PostgreSQL** (`pg`) for cross-process resume. Includes optional distributed locks.

See [docs/orchestration.md](docs/orchestration.md#state-persistence).

#### Human approval gates (DAG)

DAG steps support `approvalGate` with role-based approvers, timeouts, escalation, signed decisions, and `ApprovalStore` persistence.

See [docs/orchestration.md](docs/orchestration.md#human-approval-gates).

#### Native OpenTelemetry exporter

First-party OTLP/HTTP JSON exporter with GenAI semantic conventions, batching, retry, and RunContext-aware resource grouping.

```ts
import { OtelExporter, createOtelExporter } from 'ottrix/exporters/otel';

getTelemetry().addExporter(createOtelExporter('datadog', {
  apiKey: process.env.DD_API_KEY!,
  serviceName: 'my-agent',
}));
```

Subpath: `ottrix/exporters/otel`. See [docs/observability.md](docs/observability.md).

#### Multi-scope budget enforcement

Budget guardrail supports a scope stack — **agent → run → org → global** — with USD cost accounting via per-1k token rates. Global configuration via `configureBudgets()`.

```ts
import { configureBudgets } from 'ottrix/guardrails';

configureBudgets({
  scopes: [
    { name: 'agent', source: 'agentDef', cap: { maxTokens: 1000 } },
    { name: 'org', source: (ctx) => ctx.orgId as string, cap: { maxCostUsd: 10, period: 'month' } },
  ],
  onBreachDefault: 'terminate',
});
```

New stop reason: **`cost_budget`**. See [docs/guardrails.md](docs/guardrails.md).

#### AuditEmitter (SOC2-ready audit trail)

Append-only audit system with automatic lifecycle emits, optional HMAC signing, field redaction, and pluggable sinks (`ConsoleSink`, `InMemorySink`, `FileSink`).

```ts
import { AuditEmitter, FileSink, HmacSigner, useAudit } from 'ottrix';

useAudit(new AuditEmitter({
  sink: new FileSink({ path: './audit.jsonl' }),
  signer: new HmacSigner({ secret: process.env.AUDIT_SECRET! }),
  redact: ['args.token', 'args.password'],
}));
```

See [docs/guardrails.md](docs/guardrails.md).

#### `@ottrix/nestjs` adapter

First-party NestJS integration package in `packages/nestjs/` — `OttrixModule.forRoot/forFeature`, guards (`InjectionGuard`, `BudgetGuard`), interceptors (`RunContextInterceptor`, `TelemetryInterceptor`), SSE helper, and health indicator.

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core
```

See [docs/nestjs.md](docs/nestjs.md) and [packages/nestjs/README.md](packages/nestjs/README.md).

### Changed

- `AuditLogger` moved to `src/guardrails/audit-logger.ts`; re-exported for backward compatibility
- Agent scope budget keys include `runId` to prevent cross-run budget leakage
- `createGuardrails()` merges global `configureBudgets()` when no per-agent budget is set
- `GuardrailAction` includes `'suspend'` for budget approval-required breaches
- OTEL exporter: Datadog default endpoint is `https://otlp.datadoghq.com`; permanent 4xx batches are dropped (not re-queued forever)

### Fixed

- OTEL exporter shutdown no longer silently drops buffered spans
- OTEL `createOtelExporter` merges auth headers with custom headers
- HMAC audit signature verification uses constant-time compare with length check
- `agent.run.end` audit events report failure on thrown errors; `Agent.stream()` now emits run lifecycle audit events
- NestJS `BudgetGuard` checks org-scoped budgets via authenticated `user.orgId`
- NestJS `forFeature` tool registration ordering race resolved
- NestJS injection guard handles `messages[].content` and blocks when sanitize cannot apply

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

[2.0.0]: https://github.com/ashwinpaulallen/ottrix/releases/tag/v2.0.0
[1.0.0]: https://github.com/ashwinpaulallen/ottrix/releases/tag/v1.0.0

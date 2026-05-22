# Overview

**Package name:** `ottrix`  
**Version constant:** `OTTRIX_VERSION` → `'1.0.0'` (deprecated aliases: `AGENT_KIT_VERSION`, `AGENTIC_FABRIC_VERSION`, `AGENT_FABRIC_VERSION`)  
**Node.js:** `>=20` (20.x, 22.x, 24.x; CI tests 20, 22, and 24)  
**Module format:** ESM (`"type": "module"`); CommonJS builds ship as `.cjs` alongside `.js`.

## Published artifact

npm publishes only:

- `dist/` — compiled JavaScript and `.d.ts` files
- `README.md`

Source (`src/`), tests, and examples are not included in the tarball.

## Subpath exports

| Import path | Built file | Purpose |
|-------------|------------|---------|
| `ottrix` | `dist/index.js` | Main public API |
| `ottrix/types` | `dist/types/index.js` | Shared TypeScript types |
| `ottrix/providers` | `dist/providers/index.js` | Provider implementations |
| `ottrix/providers/*` | `dist/providers/*.js` | Individual provider modules |
| `ottrix/tools` | `dist/tools/index.js` | Tools and MCP client |
| `ottrix/mcp-server` | `dist/tools/mcp-server.js` | `MCPServer`, `serveMCP` |
| `ottrix/memory` | `dist/memory/index.js` | Memory modules |
| `ottrix/orchestration` | `dist/orchestration/index.js` | Multi-agent workflows |
| `ottrix/guardrails` | `dist/guardrails/index.js` | Guardrail middleware |
| `ottrix/observability` | `dist/observability/index.js` | Logging, telemetry, replay |
| `ottrix/agent` | `dist/agent/index.js` | Agent internals |
| `ottrix/evals` | `dist/evals/index.js` | Evaluation framework |
| `ottrix/exporters/*` | `dist/observability/exporters/*.js` | Langfuse, Braintrust, webhook, **OTEL** exporters |
| `ottrix/exporters/otel` | `dist/observability/exporters/otel.js` | Native OTLP/HTTP exporter |
| `@ottrix/nestjs` | `packages/nestjs` | NestJS DI adapter (monorepo workspace) |

CLI bin: **`ottrix-serve`** → `dist/cli/serve.js` (MCP server hosting).

## Architectural layers

```
Application (API, CLI, MCP clients)
    ↓
Orchestration — Sequential · Parallel · Router · Supervisor · DAG · YAML
    ↓
Agent — ReAct loop · structured output (Zod) · planner · reflector
    ↓
Tools · Memory · Guardrails · Observability · Evals
    ↓
Providers — HTTP via fetch · fallback chain · circuit breaker
    ↓
Configuration (loadConfig, env)
```

## Peer dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| `zod` | Optional | Structured output, Zod tools, schema scorers |
| `js-yaml` | Optional | Full YAML parsing in `WorkflowLoader` |

Built-in LLM providers do **not** require vendor SDK packages. They call HTTP APIs with native `fetch`.

## v2 feature summary

| Area | Key symbols |
|------|-------------|
| Structured output | `outputSchema`, `parsedOutput`, `StructuredOutputError`, `zodToJsonSchema` |
| Zod tools | `createTool`, `ZodTool`, `isZodTool` |
| Tool approval (HITL) | `ApprovalHandler`, `requiresApproval` metadata, registry approval handlers |
| Provider resilience | `setFallbackChain`, `CircuitBreaker`, `CircuitOpenError` |
| MCP server | `MCPServer`, `serveMCP`, `ottrix-serve` CLI |
| Observational memory | `ObservationalMemory`, `InMemoryObservationStore` |
| Supervisor | `SupervisorWorkflow`, `createSupervisor` |
| DAG workflows | `DAGWorkflow`, `DAGBuilder`, suspend/resume, `InMemoryStateStore` |
| Evals | `evaluate`, `EvalRunner`, scorers, `EvalReporter` |
| Trace exporters | `LangfuseExporter`, `BraintrustExporter`, `WebhookExporter`, **`OtelExporter`**, `MultiExporter` |
| Prompt injection | `PromptInjectionGuardrail` — **enabled by default** in `createGuardrails` |
| Run context | `RunContext`, `runWith`, ALS propagation across agent/workflow/audit/OTEL |
| Multi-scope budget | `configureBudgets`, agent/run/org/global USD cost caps |
| Audit trail | `AuditEmitter`, `useAudit`, automatic SOC2 lifecycle events |
| Tool safety | Destructive/sandbox/approval metadata on tools |
| Idempotent tools | `IdempotencyStore`, deduplicated tool execution |
| Workflow state stores | `RedisStateStore`, `PostgresStateStore` for DAG suspend/resume |
| Human approval gates | DAG `approvalGate`, signed decisions, `ApprovalStore` |
| NestJS adapter | `@ottrix/nestjs` — DI, guards, interceptors, SSE, health |

See each module document for complete symbol lists and behavior.

## Branch commit → documentation index

Maps commits on the `RunContext-via-AsyncLocalStorage` branch:

| Commit | Feature | Document |
|--------|---------|----------|
| `7895d45` | RunContext via AsyncLocalStorage | [context.md](./context.md) |
| `1039351` | Tool safety envelope, idempotent execution | [tools.md](./tools.md#tool-safety-envelope) |
| `1039351` | Pluggable workflow state stores | [orchestration.md](./orchestration.md#state-persistence) |
| `1039351` | Human approval gates for DAG | [orchestration.md](./orchestration.md#human-approval-gates) |
| `a40ea26` | Native OTEL exporter | [observability.md](./observability.md#otelexporter) |
| `a40ea26` | Multi-scope budget + USD cost accounting | [guardrails.md](./guardrails.md#budgetguardrail-multi-scope) |
| `a40ea26` | AuditEmitter (SOC2 audit trail) | [guardrails.md](./guardrails.md#auditemitter-soc2-ready-audit-trail) |
| `a40ea26` | `@ottrix/nestjs` adapter | [nestjs.md](./nestjs.md) |

Prior v2 commits (1.0.0 release):

| Commit | Feature | Document |
|--------|---------|----------|
| Structured output (Zod) | [agent.md](./agent.md) |
| Fallback chain, circuit breaker | [providers.md](./providers.md) |
| Zod tools, tool approval | [tools.md](./tools.md) |
| Observational memory | [memory.md](./memory.md) |
| Supervisor, DAG, suspend/resume | [orchestration.md](./orchestration.md) |
| Evals, trace exporters | [evals.md](./evals.md), [observability.md](./observability.md) |
| Prompt injection (default) | [guardrails.md](./guardrails.md) |

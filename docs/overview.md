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
| `ottrix/exporters/*` | `dist/observability/exporters/*.js` | Langfuse, Braintrust, webhook exporters |

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
| Trace exporters | `LangfuseExporter`, `BraintrustExporter`, `WebhookExporter`, `MultiExporter` |
| Prompt injection | `PromptInjectionGuardrail` — **enabled by default** in `createGuardrails` |

See each module document for complete symbol lists and behavior.

## Branch commit → documentation index

Maps the v2 feature branch commits to module docs:

| Git commit (summary) | Document |
|----------------------|----------|
| `9a7d1db` — Zod + structured outputs | [agent.md](./agent.md#structured-output-zod) |
| `9e15667` — Fallback chain + circuit breaker | [providers.md](./providers.md) |
| `0dfd9ad` — Zod tools + HITL approval | [tools.md](./tools.md) |
| `6e2b75f` — Observational memory | [memory.md](./memory.md#observationalmemory) |
| `0b66e65` — Supervisor + DAG orchestration | [orchestration.md](./orchestration.md) |
| `8887e9e` — Evals + observability exporters | [evals.md](./evals.md), [observability.md](./observability.md) |
| `49b5df6` — Prompt injection guardrails | [guardrails.md](./guardrails.md#promptinjectionguardrail) |

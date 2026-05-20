# Overview

**Package name:** `agentic-fabric`  
**Version constant:** `AGENTIC_FABRIC_VERSION` (deprecated alias: `AGENT_FABRIC_VERSION`)  
**Node.js:** `>=20` (20.x, 22.x, 24.x; CI tests 20, 22, and 24)  
**Module format:** ESM (`"type": "module"`); CommonJS builds ship as `.cjs` alongside `.js`.

## Published artifact

npm publishes only:

- `dist/` — compiled JavaScript and `.d.ts` files
- `README.md`

Source (`src/`), tests, and examples are not included in the tarball.

## Subpath exports

| Import path | Source barrel | Purpose |
|-------------|---------------|---------|
| `agentic-fabric` | `src/index.ts` | Main public API |
| `agentic-fabric/types` | `src/types/index.ts` | Shared TypeScript types |
| `agentic-fabric/providers` | `src/providers/index.ts` | Provider implementations |
| `agentic-fabric/providers/anthropic` | `src/providers/anthropic.ts` | Anthropic-only import |
| `agentic-fabric/providers/openai` | `src/providers/openai.ts` | OpenAI-only import |
| `agentic-fabric/providers/ollama` | `src/providers/ollama.ts` | Ollama-only import |
| `agentic-fabric/providers/base` | `src/providers/base.ts` | `BaseProvider` for extensions |
| `agentic-fabric/tools` | `src/tools/index.ts` | Tools and MCP |
| `agentic-fabric/memory` | `src/memory/index.ts` | Memory modules |
| `agentic-fabric/orchestration` | `src/orchestration/index.ts` | Multi-agent workflows |
| `agentic-fabric/guardrails` | `src/guardrails/index.ts` | Guardrail middleware and handlers |
| `agentic-fabric/observability` | `src/observability/index.ts` | Logging, telemetry, replay |
| `agentic-fabric/agent` | `src/agent/index.ts` | Agent internals (planner, reflector, helpers) |

Wildcard `./providers/*` maps to individual provider entry files in `dist/providers/`.

## Architectural layers

```
Application
    ↓
Orchestration (workflows, WorkflowLoader)
    ↓
Agent (ReAct loop)
    ↓
Tools · Memory · Guardrails · Observability
    ↓
Providers (HTTP via fetch)
    ↓
Configuration (loadConfig, env)
```

## Peer dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| `js-yaml` | Optional | Full YAML parsing in `WorkflowLoader` when `parseWorkflowFile` handles `.yaml`/`.yml` |

Built-in LLM providers do **not** require vendor SDK packages (`@anthropic-ai/sdk`, `openai`, etc.). They call HTTP APIs with native `fetch`.

## Main entry exports (summary)

The root `agentic-fabric` export includes:

- **Agent:** `Agent`, `createAgent`, `quickAgent`
- **Config:** `loadConfig`, `defineConfig`, `getAgenticEnv`, `readAgenticEnv`, …
- **Providers:** factories, `ProviderRegistry`, `BaseProvider`, `ProviderError`
- **Tools:** `FunctionTool`, `ToolRegistry`, MCP types
- **Memory:** `WorkingMemory`, `SemanticMemory`, `EpisodicMemory`, …
- **Orchestration:** workflow classes, `WorkflowLoader`
- **Guardrails:** `createGuardrails`, `GuardrailMiddleware`
- **Observability:** `Logger`, `Telemetry`, `RunRecorder`, exporters

See each module document for complete symbol lists and behavior.

# Migration guide

This document describes how to upgrade between **agentic-fabric** versions.

## Unreleased

_No breaking changes yet._

---

## 2.0.0

Release date: 2026-05-19. See [CHANGELOG](../CHANGELOG.md) for the full feature list.

### Install

```bash
npm install agentic-fabric@2
```

### New capabilities (additive)

| Feature | Action required |
|---------|-----------------|
| Structured output | Install optional `zod` peer; pass `outputSchema` to `agent.run()` |
| Zod tools | Use `createTool` instead of manual JSON Schema |
| Provider fallback | Configure `ProviderRegistry.setFallbackChain()` |
| MCP server | Import `agentic-fabric/mcp-server` or use `agentic-serve` CLI |
| Observational memory | Wire `ObservationalMemory` on `AgentConfig` |
| Supervisor / DAG | Import from `agentic-fabric/orchestration` |
| Evals | Import from `agentic-fabric/evals` |
| Trace exporters | Set `telemetry.exporter` or `getTelemetry().setExporter()` |
| Prompt injection | **On by default** — see below |

### Prompt injection (default on)

v2 enables `PromptInjectionGuardrail` automatically when guardrails are active (`createAgent` default).

**No action needed** for most apps — suspicious inputs are blocked before reaching the LLM.

To customize:

```ts
createAgent({
  guardrails: { promptInjection: { mode: 'flag', strictness: 'high' } },
});
```

To disable injection only:

```ts
createAgent({ guardrails: { promptInjection: false } });
```

To disable all guardrails:

```ts
createAgent({ guardrails: false });
```

### New subpath exports

```ts
import { evaluate } from 'agentic-fabric/evals';
import { serveMCP } from 'agentic-fabric/mcp-server';
import { LangfuseExporter } from 'agentic-fabric/exporters/langfuse';
```

Existing subpaths (`providers`, `tools`, `memory`, `orchestration`, `guardrails`, `observability`) unchanged.

### Version constant

```ts
import { AGENTIC_FABRIC_VERSION } from 'agentic-fabric';
// '2.0.0'
```

### Breaking changes

None intended for v1 APIs. New features are opt-in except prompt injection when guardrails are enabled.

### Peer dependencies

| Package | Required for |
|---------|--------------|
| `zod` | Structured output, Zod tools, `SchemaMatchScorer` |
| `js-yaml` | Full YAML workflow files (unchanged from v1) |

---

## 1.0.0 (initial release)

First public release on npm as `agentic-fabric` (source repository: [agent-fabric](https://github.com/ashwinpaulallen/agent-fabric)).

### Install

```bash
npm install agentic-fabric
```

### Imports

```ts
import { createAgent } from 'agentic-fabric';
import { createAnthropicProvider } from 'agentic-fabric/providers';
```

Subpath exports: `agentic-fabric/providers`, `agentic-fabric/tools`, `agentic-fabric/memory`, `agentic-fabric/orchestration`, `agentic-fabric/guardrails`, `agentic-fabric/observability`, `agentic-fabric/types`, `agentic-fabric/agent`.

### Version constant

```ts
import { AGENTIC_FABRIC_VERSION } from 'agentic-fabric';
```

`AGENT_FABRIC_VERSION` remains available as a deprecated alias.

### Error types

| Area | Typed errors |
|------|----------------|
| Providers | `ProviderError` (`code`, `retryable`), `CircuitOpenError` (v2+) |
| Tools | `ToolValidationError`, `DuplicateToolError`, `ToolNotFoundError` |
| MCP | `MCPProtocolError`, `MCPToolError`, `MCPRegistryConnectError` |
| Config | `ConfigValidationError` |
| Workflows | `WorkflowTimeoutError`, DAG errors (v2+) |
| Structured output | `StructuredOutputError` (v2+) |

### Peer dependencies

- **`js-yaml`** (optional) — required only for YAML workflow files via `WorkflowLoader`
- No Anthropic/OpenAI SDK peers — built-in providers use native `fetch`

### Node.js

Requires Node.js `>=20`.

---

## Future versions

When upgrading to a new major or minor release:

1. Read the [CHANGELOG](CHANGELOG.md) for breaking changes.
2. Run your test suite against the new version.
3. Check environment variable renames under `AGENTIC_*` in the README.
4. Review [docs/](README.md) for module-specific behavior.

Breaking changes will be documented here with before/after examples.

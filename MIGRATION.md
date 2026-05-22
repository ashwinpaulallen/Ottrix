# Migration guide

This document describes how to upgrade between **agent-kit** versions.

## Unreleased

_No breaking changes yet._

---

## Package renamed: `agentic-fabric` → `agent-kit`

The npm package is now **`agent-kit`**. Legacy names remain as deprecated aliases where noted below.

| Before | After |
|--------|-------|
| `npm install agentic-fabric` | `npm install agent-kit` |
| `import { createAgent } from 'agentic-fabric'` | `import { createAgent } from 'agent-kit'` |
| `agentic-serve` CLI | `agent-kit-serve` |
| `AGENTIC_FABRIC_VERSION` | `AGENT_KIT_VERSION` |
| `AGENTIC_*` env vars | `AGENT_KIT_*` (legacy `AGENTIC_*` still read) |
| `.agenticrc.json` | `.agentkitrc.json` (legacy `.agenticrc.*` still discovered) |

Subpath imports use the new package name: `agent-kit/evals`, `agent-kit/mcp-server`, `agent-kit/exporters/langfuse`, etc.

---

## 1.0.0

Release date: 2026-05-19. See [CHANGELOG](../CHANGELOG.md) for the full feature list.

### Install

```bash
npm install agent-kit
```

### New capabilities (additive)

| Feature | Action required |
|---------|-----------------|
| Structured output | Install optional `zod` peer; pass `outputSchema` to `agent.run()` |
| Zod tools | Use `createTool` instead of manual JSON Schema |
| Provider fallback | Configure `ProviderRegistry.setFallbackChain()` |
| MCP server | Import `agent-kit/mcp-server` or use `agent-kit-serve` CLI |
| Observational memory | Wire `ObservationalMemory` on `AgentConfig` |
| Supervisor / DAG | Import from `agent-kit/orchestration` |
| Evals | Import from `agent-kit/evals` |
| Trace exporters | Set `telemetry.exporter` or `getTelemetry().setExporter()` |
| Prompt injection | **On by default** — see below |

### Prompt injection (default on)

`PromptInjectionGuardrail` is enabled automatically when guardrails are active (`createAgent` default).

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
import { evaluate } from 'agent-kit/evals';
import { serveMCP } from 'agent-kit/mcp-server';
import { LangfuseExporter } from 'agent-kit/exporters/langfuse';
```

Existing subpaths (`providers`, `tools`, `memory`, `orchestration`, `guardrails`, `observability`) unchanged.

### Version constant

```ts
import { AGENT_KIT_VERSION } from 'agent-kit';
// '1.0.0'
```

### Breaking changes

New features are opt-in except prompt injection when guardrails are enabled.

### Peer dependencies

| Package | Required for |
|---------|--------------|
| `zod` | Structured output, Zod tools, `SchemaMatchScorer` |
| `js-yaml` | Full YAML workflow files (unchanged from v1) |

---

## Future versions

When upgrading to a new major or minor release:

1. Read the [CHANGELOG](CHANGELOG.md) for breaking changes.
2. Run your test suite against the new version.
3. Check environment variable renames under `AGENTIC_*` in the README.
4. Review [docs/](README.md) for module-specific behavior.

Breaking changes will be documented here with before/after examples.

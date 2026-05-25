# Migration guide

This document describes how to upgrade between **Ottrix** versions.

## Unreleased

_No breaking changes yet._

---

## 2.1.0

Release date: 2026-05-25.

### Breaking: exporters and MCP server moved to standalone packages

Heavy integrations are no longer bundled in **`ottrix`**. Install the package you need:

| Removed import | Replacement |
|----------------|-------------|
| `ottrix/exporters/langfuse` | `@ottrix/exporter-langfuse` |
| `ottrix/exporters/braintrust` | `@ottrix/exporter-braintrust` |
| `ottrix/exporters/otel` | `@ottrix/exporter-otel` |
| `ottrix/mcp-server` | `@ottrix/mcp-server` |
| `ottrix-serve` CLI (from `ottrix` bin) | `npx ottrix-serve` from `@ottrix/mcp-server` |

**Before:**

```ts
import { LangfuseExporter } from 'ottrix/exporters/langfuse';
import { BraintrustExporter } from 'ottrix/exporters/braintrust';
import { createOtelExporter } from 'ottrix/exporters/otel';
import { serveMCP } from 'ottrix/mcp-server';
```

**After:**

```bash
npm install @ottrix/exporter-langfuse @ottrix/exporter-braintrust @ottrix/exporter-otel @ottrix/mcp-server
```

```ts
import { LangfuseExporter } from '@ottrix/exporter-langfuse';
import { BraintrustExporter } from '@ottrix/exporter-braintrust';
import { createOtelExporter } from '@ottrix/exporter-otel';
import { serveMCP } from '@ottrix/mcp-server';
```

### Still in core

- **MCP client** — `MCPClient`, `MCPRegistry`, `MCPToolProvider` remain on `ottrix` / `ottrix/tools`
- **Built-in trace exporters** — `TraceConsoleExporter`, `InMemoryTraceExporter`, `WebhookExporter`, `MultiExporter`
- **Webhook subpath** — `ottrix/exporters/webhook` (unchanged)

### Config-based exporters

`telemetry.exporter: 'langfuse' | 'braintrust'` no longer auto-wires exporters. Ottrix logs a migration hint at startup. Install the standalone package and register manually:

```ts
import { getTelemetry } from 'ottrix';
import { LangfuseExporter } from '@ottrix/exporter-langfuse';

getTelemetry().addExporter(new LangfuseExporter({ /* ... */ }));
```

### Upgrade

```bash
npm install ottrix@2.1
```

---

## 2.0.0

Release date: 2026-05-23. See [CHANGELOG](CHANGELOG.md) for the full feature list.

### Upgrade from 1.x

```bash
npm install ottrix@2
```

If you use the NestJS adapter:

```bash
npm install @ottrix/nestjs ottrix@2 @nestjs/common @nestjs/core rxjs
```

`@ottrix/nestjs` requires **`ottrix` ≥2.0.0** as a peer dependency.

### Version constant

```ts
import { OTTRIX_VERSION } from 'ottrix';
// '2.0.0'
```

### New capabilities (additive)

| Feature | Doc |
|---------|-----|
| Run context (AsyncLocalStorage) | [packages/core/docs/context.md](packages/core/docs/context.md) |
| Tool safety envelope + idempotent execution | [packages/core/docs/tools.md](packages/core/docs/tools.md) |
| Redis/Postgres workflow state stores | [packages/core/docs/orchestration.md](packages/core/docs/orchestration.md) |
| DAG human approval gates | [packages/core/docs/orchestration.md](packages/core/docs/orchestration.md) |
| Native OTEL exporter (`@ottrix/exporter-otel`) | [packages/exporter-otel/README.md](packages/exporter-otel/README.md) |
| Multi-scope budget (USD) + `configureBudgets()` | [packages/core/docs/guardrails.md](packages/core/docs/guardrails.md) |
| `AuditEmitter` SOC2 audit trail | [packages/core/docs/guardrails.md](packages/core/docs/guardrails.md) |
| `@ottrix/nestjs` adapter | [packages/nestjs/docs/guide.md](packages/nestjs/docs/guide.md) |

### Changed behavior

- Agent-scope budget keys include `runId` to prevent cross-run budget leakage
- `createGuardrails()` merges global `configureBudgets()` when no per-agent budget is set
- `GuardrailAction` includes `'suspend'` for budget approval-required breaches
- OTEL exporter: Datadog default endpoint is `https://otlp.datadoghq.com`; permanent 4xx batches are dropped

### Breaking / migration notes

Most 2.0 features are opt-in. Notable changes when upgrading:

| Change | Action |
|--------|--------|
| `@ottrix/nestjs` peer | Upgrade `ottrix` to 2.x before installing or updating the NestJS package |
| `AuditLogger` location | Moved internally; still re-exported from `ottrix/guardrails` for compatibility |
| Budget scopes | If you rely on agent-level budgets across concurrent runs, scopes now isolate by `runId` |

Prompt injection guardrails remain **on by default** when guardrails are enabled (unchanged from 1.0).

---

## Package renamed: `agentic-fabric` → `ottrix`

The npm package is now **`ottrix`**. Legacy names remain as deprecated aliases where noted below.

| Before | After |
|--------|-------|
| `npm install agentic-fabric` | `npm install ottrix` |
| `import { createAgent } from 'agentic-fabric'` | `import { createAgent } from 'ottrix'` |
| `agentic-serve` CLI | `ottrix-serve` (from `@ottrix/mcp-server`) |
| `AGENTIC_FABRIC_VERSION` | `OTTRIX_VERSION` (deprecated: `AGENT_KIT_VERSION`, `AGENTIC_FABRIC_VERSION`, `AGENT_FABRIC_VERSION`) |
| `AGENTIC_*` env vars | `OTTRIX_*` (legacy `AGENT_KIT_*` and `AGENTIC_*` still read) |
| `.agenticrc.json` | `.ottrixrc.json` (legacy `.agentkitrc.*` / `.agenticrc.*` still discovered) |
| GitHub `agentic-fabric` / `agent-kit` | [github.com/ashwinpaulallen/ottrix](https://github.com/ashwinpaulallen/ottrix) |

Subpath imports use the new package name: `ottrix/evals`, `@ottrix/mcp-server`, `@ottrix/exporter-langfuse`, etc.

---

## 1.0.0

Release date: 2026-05-19. See [CHANGELOG](CHANGELOG.md) for the full feature list.

### Install

```bash
npm install ottrix
```

### New capabilities (additive)

| Feature | Action required |
|---------|-----------------|
| Structured output | Install optional `zod` peer; pass `outputSchema` to `agent.run()` |
| Zod tools | Use `createTool` instead of manual JSON Schema |
| Provider fallback | Configure `ProviderRegistry.setFallbackChain()` |
| MCP server | Install `@ottrix/mcp-server` or use `ottrix-serve` CLI |
| Observational memory | Wire `ObservationalMemory` on `AgentConfig` |
| Supervisor / DAG | Import from `ottrix/orchestration` |
| Evals | Import from `ottrix/evals` |
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
import { evaluate } from 'ottrix/evals';
import { serveMCP } from '@ottrix/mcp-server';
import { LangfuseExporter } from '@ottrix/exporter-langfuse';
```

Existing subpaths (`providers`, `tools`, `memory`, `orchestration`, `guardrails`, `observability`) unchanged.

### Version constant

```ts
import { OTTRIX_VERSION } from 'ottrix';
// '1.0.0'
```

`AGENT_KIT_VERSION`, `AGENTIC_FABRIC_VERSION`, and `AGENT_FABRIC_VERSION` are deprecated aliases.

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
3. Check environment variable renames under `OTTRIX_*` in the README.
4. Review [docs/README.md](docs/README.md) and `packages/*/docs/` for module-specific behavior.

Breaking changes will be documented here with before/after examples.

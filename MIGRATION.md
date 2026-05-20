# Migration guide

This document describes how to upgrade between **agentic-fabric** versions.

## Unreleased

_No breaking changes yet._

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
| Providers | `ProviderError` (`code`, `retryable`) |
| Tools | `ToolValidationError`, `DuplicateToolError`, `ToolNotFoundError` |
| MCP | `MCPProtocolError`, `MCPToolError`, `MCPRegistryConnectError` |
| Config | `ConfigValidationError` |
| Workflows | `WorkflowTimeoutError` |

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

Breaking changes will be documented here with before/after examples.

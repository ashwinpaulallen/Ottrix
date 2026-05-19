# Configuration

Sources: `src/config.ts`, `src/env.ts`, `src/factory.ts`

## Configuration merge order

`loadConfig()` merges in this order (later wins):

1. `DEFAULT_AGENTIC_CONFIG`
2. Discovered config file (`.agenticrc.json`, `.agenticrc.yaml`, `.agenticrc.yml`, or `AGENTIC_CONFIG_PATH`)
3. Environment variables (`readConfigFromEnv`)
4. Programmatic `overrides` passed to `loadConfig`

After merge, `applyProviderApiKeysFromEnv` re-applies `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OLLAMA_BASE_URL`.

## `AgenticConfig` defaults

| Field | Default |
|-------|---------|
| `defaultProvider` | `'anthropic'` |
| `providers` | `{}` |
| `defaultModel` | `ANTHROPIC_DEFAULT_MODEL` |
| `maxSteps` | `10` |
| `maxTokenBudget` | `undefined` |
| `logLevel` | `'info'` |
| `telemetry.enabled` | `true` |
| `telemetry.exporter` | `'memory'` |
| `guardrails.piiDetection` | `true` |
| `guardrails.maxCostUsd` | `undefined` |

## Environment variables

| Variable | Maps to |
|----------|---------|
| `AGENTIC_DEFAULT_PROVIDER`, `AGENTIC_PROVIDER` | `defaultProvider` |
| `AGENTIC_DEFAULT_MODEL`, `AGENTIC_MODEL` | `defaultModel` |
| `AGENTIC_MAX_STEPS` | `maxSteps` (positive integer) |
| `AGENTIC_MAX_TOKEN_BUDGET` | `maxTokenBudget` |
| `AGENTIC_LOG_LEVEL` | `logLevel` (`debug`, `info`, `warn`, `error`) |
| `AGENTIC_TELEMETRY_ENABLED` | `telemetry.enabled` (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`) |
| `AGENTIC_TELEMETRY_EXPORTER` | `telemetry.exporter` (`console`, `memory`, `none`) |
| `AGENTIC_GUARDRAILS_PII_DETECTION` | `guardrails.piiDetection` |
| `AGENTIC_GUARDRAILS_MAX_COST_USD` | `guardrails.maxCostUsd` |
| `AGENTIC_CONFIG_PATH` | Explicit config file path |
| `ANTHROPIC_API_KEY` | `providers.anthropic.apiKey` |
| `OPENAI_API_KEY` | `providers.openai.apiKey` |
| `OLLAMA_BASE_URL` | `providers.ollama.baseUrl` |
| `AGENTIC_ANTHROPIC_API_KEY`, `AGENTIC_ANTHROPIC_BASE_URL`, `AGENTIC_ANTHROPIC_MODEL` | Anthropic provider fields |
| `AGENTIC_OPENAI_*`, `AGENTIC_OLLAMA_*` | Same pattern for other providers |

Invalid `AGENTIC_LOG_LEVEL` or `AGENTIC_MAX_STEPS` in env produce **warnings**, not fatal errors.

## Config file API

| Function | Behavior |
|----------|----------|
| `defineConfig(input)` | Identity helper for typed config objects |
| `loadConfig(options?)` | Full merge + validation; returns `{ config, warnings, path? }` |
| `getConfig()` | Cached `loadConfig()` result |
| `setConfig(config)` | Set cached config |
| `resetConfigCache()` | Clear cache |
| `discoverConfigFile(cwd?, env?)` | Resolve config path |
| `readConfigFromEnv(env?)` | Env-only partial config |
| `mergeAgenticConfig(base, ...sources)` | Deep merge |
| `resolveProviderApiKey(config, name)` | Read `config.providers[name].apiKey` |
| `isBuiltInProviderName(name)` | `anthropic` \| `openai` \| `ollama` |

### Config file errors (`Error`)

- Unsupported file extension
- File root is not an object
- JSON/YAML parse failure

### Fatal validation (`ConfigValidationError`)

Thrown when merged config is invalid:

- Empty `defaultProvider` or `defaultModel`
- `maxSteps` not finite or &lt; 1
- `maxTokenBudget` &lt; 1 when set
- Invalid `logLevel`
- `guardrails.maxCostUsd` &lt; 0 when set

`ConfigValidationError` has `issues: ConfigIssue[]`.

### Deprecation warnings (non-fatal)

| Deprecated | Replacement |
|------------|-------------|
| `provider` | `defaultProvider` |
| `model` | `defaultModel` |
| `telemetryEnabled` | `telemetry.enabled` |

---

## Environment helpers (`src/env.ts`)

| Function | Behavior |
|----------|----------|
| `readAgenticEnv(env?)` | **Env only** — no config file |
| `getAgenticEnv()` | Cached `configToAgenticEnv()` (includes config file) |
| `configToAgenticEnv(env?)` | `toAgenticEnv(loadConfig({ env }).config)` |
| `resetAgenticEnvCache()` | Clears env cache + `resetConfigCache()` |
| `resolveApiKey(provider, override?, env?)` | Override or `loadConfig` + `resolveProviderApiKey` |

`AgenticEnv` shape: `provider?`, `model?`, `anthropicApiKey?`, `openaiApiKey?`, `ollamaBaseUrl?`, `logLevel?` (excludes `'silent'`), `maxSteps?`.

---

## `createAgent(config?)`

**File:** `src/factory.ts`

Builds an `Agent` with opinionated defaults from merged `AgenticConfig`.

### `CreateAgentConfig`

| Field | Default / behavior |
|-------|-------------------|
| `name` | `'agent'` |
| `provider` | Built-in name or `CompletionProvider` instance; else `agentic.defaultProvider` |
| `apiKey`, `baseUrl`, `model` | Merged into config overrides and provider factory |
| `tools` | Non-empty → new `ToolRegistry` with tools registered |
| `memory` | `true` or omitted → internal `KeywordMemoryProvider`; `false` → none; object → used as-is |
| `telemetry` | `false` → none; object → that instance; else global telemetry if `agentic.telemetry.enabled` |
| `guardrails` | `false` → none; `true`/omitted → `createGuardrails` from agentic config; object → merged |
| `contextLimitTokens` | `128_000` |
| `keepRecentMessages` | `6` |
| `systemPrompt`, `maxSteps`, `maxTokenBudget` | Passed to `Agent` |

Calls `loadConfig({ overrides: toConfigOverrides(config) })` and `applyConfigDefaults` (sets global logger once via `markCreateAgentDefaultsApplied`).

### Errors

| Error | When |
|-------|------|
| `Error` | Unknown string provider name |
| `ProviderError` (`code: 'auth'`) | Anthropic/OpenAI without API key |
| `Error` | Unsupported provider after switch |
| `ConfigValidationError` | Invalid merged config |

### `KeywordMemoryProvider` (internal, not exported)

Used when `memory: true`. Keyword scoring over stored entries; default retrieve limit **5**.

---

## `quickAgent(prompt, options?)`

Creates agent with `name: 'quick'`, default system prompt `'You are a helpful assistant.'`, runs `agent.run(prompt)`, returns `result.response`.

`QuickAgentOptions` picks: `provider`, `apiKey`, `baseUrl`, `model`, `systemPrompt`, `maxSteps`, `tools`, `memory`, `telemetry`, `guardrails`.

---

## `resetCreateAgentDefaults()`

Resets one-time logger/telemetry setup flag (`resetCreateAgentDefaultsState`) for tests.

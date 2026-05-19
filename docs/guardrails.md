# Guardrails

Source: `src/guardrails/`

Guardrails run as a **middleware pipeline** around LLM calls and tool execution, and as **validators** on agent input/output strings.

## `createGuardrails(options?)`

**File:** `src/guardrails/factory.ts`

Returns `{ middleware, budget?, audit?, config }`.

| Option | Default |
|--------|---------|
| `agentName` | `'agent'` |

### Handler order (when each config key is set)

1. `AuditLogger` (if `audit` config)
2. `BudgetGuardrail` (if `budget` config)
3. `PiiDetector` (if `piiDetection` / `pii`)
4. `ContentFilter` (if `contentFilter`)
5. `SchemaValidator` (if `schema`)
6. `MaxLengthValidator` (if `maxLength`)
7. `HumanApprovalGuardrail` (if `humanApproval`)

`config` output maps budget limits into `GuardrailConfig` for the agent:

- `maxSteps`, `maxTokenBudget`, `maxCostUsd` from budget
- `inputValidators: [piiDetector]` when PII enabled
- `outputValidators` from content filter, schema, max length

---

## `GuardrailMiddleware`

**File:** `src/guardrails/middleware.ts`

| Method | Behavior |
|--------|----------|
| `use(handler)` | Append handler |
| `listHandlers()` | Readonly handler list |
| `getBudgetGuardrail()` / `getAuditLogger()` | Find by `name === 'budget'` or `'audit'` |
| `reset()` | Calls `reset()` on stateful handlers |
| `beforeLlm` / `afterLlm` | Sequential pipeline; stops on `action: 'block'` |
| `beforeTool` / `afterTool` | Same for tool phase |
| `logDecision` | Routes non-allow decisions to audit |

### Decision actions (`GuardrailAction`)

`allow` · `block` · `modify` · `flag`

**Block:** `proceed: false`, `reason` (default `'Blocked by guardrail'`), `code` (default `'guardrail'`).

**Modify:** Updates `modifiedText` (LLM) or `toolInput` / `toolResultMessage` (tool).

**Flag:** Proceeds but accumulates `flags` strings.

### Block codes (`GuardrailBlockCode`)

`max_steps` · `token_budget` · `cost_budget` · `guardrail`

`completionText(result)` — extracts text from `CompletionResult` content blocks.

---

## Validators

**File:** `src/guardrails/validators.ts`

### `PiiDetector` (`name: 'pii-detector'`)

| Option | Default |
|--------|---------|
| `mode` | `'detect'` |
| `blockOnDetect` | `false` |

Patterns: email, phone, SSN, credit card.

- **detect** + `blockOnDetect`: blocks on match
- **redact**: `afterLlm` returns `modify` with `[REDACTED]` substitutions
- Otherwise **flag** with `pii:{label}`

Exports: `detectPii`, `redactPii`.

### `ContentFilter` (`name: 'content-filter'`)

| Option | Default |
|--------|---------|
| `action` | `'block'` |

String patterns compiled case-insensitively. `validate` and `afterLlm` mirror block/flag.

### `SchemaValidator` (`name: 'schema-validator'`)

Extracts JSON from fenced blocks or `{...}` slice; `validateSchema`; blocks on failure in `afterLlm`.

### `MaxLengthValidator` (`name: 'max-length'`)

| Option | Default |
|--------|---------|
| `charsPerToken` | `4` when `maxTokens` set |

Blocks on `maxCharacters` or estimated token count.

---

## `HumanApprovalGuardrail`

**File:** `src/guardrails/human-in-the-loop.ts`  
**Name:** `human-approval`

**Required:**

- `shouldRequireApproval(toolName, input) => boolean`
- `requestApproval(step: AgentStep) => Promise<boolean>`

`beforeTool`: if approval required, builds step from `pendingStep` or synthetic `tool_call`; denial → `block` with `toolResultMessage` explaining rejection.

---

## `AuditLogger`

**File:** `src/guardrails/audit.ts`  
**Name:** `audit`

| Option | Default |
|--------|---------|
| `agentName` | `'agent'` |
| `console` | `false` |

Hooks: `llm_pre`, `llm_post` (with usage/duration), `tool_pre`, `tool_post`, `guardrail_decision`.

| Method | Behavior |
|--------|----------|
| `getLogs()` | In-memory entries |
| `exportLogs(pretty?)` | JSON string |
| `clear()` | Empty logs |

Sinks: in-memory array, optional `console.info`, custom `handler`, `appendFile(filePath)` (JSON lines).

Never returns blocking decisions from audit hooks.

---

## `BudgetGuardrail`

**File:** `src/guardrails/budget.ts`  
**Name:** `budget` (stateful)

| Option | Default |
|--------|---------|
| `defaultCostPer1k` | `{ inputPer1k: 0.005, outputPer1k: 0.015 }` |
| `costPer1kByProvider` | `{}` |

| Hook | Behavior |
|------|----------|
| `beforeLlm` (pre) | `checkBudgets`; then `stepCount += 1` |
| `afterLlm` | `recordUsage` from `context.result.usage`; `checkBudgets` |
| `beforeTool` (pre) | `checkBudgets` only (no step increment) |

**Blocks when:**

- `stepCount >= maxSteps` → `max_steps`
- `totalTokens >= maxTokenBudget` → `token_budget`
- `totalCostUsd >= maxCostUsd` → `cost_budget`

| Method | Behavior |
|--------|----------|
| `getRemainingBudget()` | Remaining steps/tokens/cost |
| `getUsageSnapshot()` | Current counters |
| `recordUsage(usage, providerName?)` | Manual usage recording |
| `reset()` | Zero counters |

`estimateCostUsd(usage, rates)` — same formula as provider registry.

---

## Agent integration

- `Agent` calls `guardrailMiddleware.beforeLlm` / `afterLlm` around each completion
- Tool calls use `beforeTool` / `afterTool`
- `config.guardrails` validators run on input before loop and on final output text
- `checkRunGuardrails` in agent loop enforces step/token/cost from `GuardrailConfig`

---

## Subpath `agentic-fabric/guardrails`

Exports middleware, `createGuardrails`, budget, validators, human approval, audit, and guardrail context types (`GuardrailHandler`, `LlmGuardrailContext`, `ToolGuardrailContext`, etc.).

Root `agentic-fabric` exports `createGuardrails`, `GuardrailMiddleware`, and `CreateGuardrailsConfig` types only.

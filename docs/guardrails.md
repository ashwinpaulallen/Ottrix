# Guardrails

Source: `src/guardrails/`

Guardrails run as a **middleware pipeline** around LLM calls and tool execution, and as **validators** on agent input/output strings.

## `createGuardrails(options?)`

**File:** `src/guardrails/factory.ts`

Returns `{ middleware, budget?, audit?, config }`.

| Option | Default |
|--------|---------|
| `agentName` | `'agent'` |
| `promptInjection` | Enabled (`block`, `medium`, scan tool outputs); `false` to disable |

### Handler order

1. `AuditLogger` (if `audit` config)
2. `BudgetGuardrail` (if `budget` config)
3. `PiiDetector` (if `pii` config)
4. `ContentFilter` (if `contentFilter`)
5. `SchemaValidator` (if `outputSchema` in guardrails config — distinct from agent Zod output)
6. `MaxLengthValidator` (if `maxOutputLength`)
7. `HumanApprovalGuardrail` (if `humanApproval`)
8. **`PromptInjectionGuardrail`** — **always included unless `promptInjection: false`**

`createAgent` with default guardrails (`guardrails: true` or omitted) includes prompt injection protection with no extra configuration.

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

`allow` · `block` · `modify` · `flag` · **`suspend`**

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

## `AuditLogger` (legacy guardrail handler)

**File:** `src/guardrails/audit-logger.ts`  
**Name:** `audit`

Legacy guardrail handler that records LLM/tool/guardrail events as `AuditLogEntry` records.

| Option | Default |
|--------|---------|
| `agentName` | `'agent'` |
| `console` | `false` |

Hooks: `llm_pre`, `llm_post`, `tool_pre`, `tool_post`, `guardrail_decision`, `injection_scan` (hash only).

Re-exported from `ottrix/guardrails` for backward compatibility. Prefer **`AuditEmitter`** for SOC2-style append-only trails.

---

## `AuditEmitter` (SOC2-ready audit trail)

**File:** `src/guardrails/audit.ts`

Append-only audit system with automatic lifecycle emits, optional HMAC signing, and field redaction. No manual `emit()` calls required in application code — framework internals emit fire-and-forget events.

### Registration

```ts
import { AuditEmitter, FileSink, HmacSigner, useAudit } from 'ottrix';

useAudit(new AuditEmitter({
  sink: new FileSink({ path: './audit.jsonl' }),
  signer: new HmacSigner({ secret: process.env.AUDIT_SECRET! }),
  redact: ['args.token', 'args.password', 'args.apiKey'],
  filter: (event) => event.type !== 'tool.invoke', // optional
}));
```

### Event types

`agent.run.start` · `agent.run.end` · `tool.invoke` · `tool.allow` · `tool.deny` · `tool.success` · `tool.fail` · `guardrail.check` · `guardrail.trip` · `approval.request` · `approval.decide` · `policy.check` · `policy.deny` · `budget.breach` · `budget.warn` · `workflow.step.start` · `workflow.step.end` · `workflow.suspend` · `workflow.resume`

### Built-in sinks

| Class | Purpose |
|-------|---------|
| `ConsoleSink` | Pretty-print (development) |
| `InMemorySink` | Tests and inspection (`getEvents()`) |
| `FileSink` | Append JSON lines to a file |

Interfaces for user implementation: `PostgresSink`, `WebhookSink`.

### Signer

`HmacSigner` — HMAC-SHA256 over canonical JSON for tamper-evidence (`sign` / `verify`).

### Automatic emit points

| Component | Events |
|-----------|--------|
| `Agent.run()` / `Agent.stream()` | `agent.run.start`, `agent.run.end` |
| `ToolRegistry.execute()` | `tool.invoke`, `tool.allow`, `tool.deny`, `tool.success`, `tool.fail`, `policy.check`, `policy.deny`, `approval.*` |
| `GuardrailMiddleware` | `guardrail.check` (budget handler excluded — uses dedicated budget events) |
| `PromptInjectionGuardrail` | `guardrail.trip` |
| `BudgetGuardrail` | `budget.breach`, `budget.warn` |
| `HumanApprovalGuardrail` / DAG approval gates | `approval.request`, `approval.decide` |
| `DAGWorkflow` | `workflow.step.*`, `workflow.suspend`, `workflow.resume` |

Every event automatically includes the current **`RunContext`** from ALS (`runId`, `orgId`, etc.). Sink errors are logged and never crash the agent.

### API

| Symbol | Purpose |
|--------|---------|
| `useAudit(emitter)` | Register global emitter |
| `getAuditEmitter()` | Get global instance |
| `resetAudit()` | Clear global (tests) |

---

## `BudgetGuardrail` (multi-scope)

**File:** `src/guardrails/budget.ts`  
**Name:** `budget` (stateful)

Tracks step, token, and **USD cost** budgets across a **scope stack**: agent → run → org → global. Innermost applicable scope is checked first; first breach wins.

### Legacy flat options

```ts
new BudgetGuardrail({ maxSteps: 10, maxTokenBudget: 8000, maxCostUsd: 1.0 })
```

Converted internally to a single agent scope.

### Multi-scope configuration

```ts
import { configureBudgets, BudgetGuardrail } from 'ottrix/guardrails';

configureBudgets({
  scopes: [
    { name: 'agent', source: 'agentDef', cap: { maxTokens: 1000, maxSteps: 10 }, onBreach: 'terminate' },
    { name: 'run', source: (ctx) => ctx.runId, cap: { maxTokens: 5000 } },
    { name: 'org', source: (ctx) => ctx.orgId as string, cap: { maxCostUsd: 10, period: 'month' } },
    { name: 'global', source: () => 'global', cap: { maxCostUsd: 100, period: 'month' } },
  ],
  onBreachDefault: 'terminate',
  store: new InMemoryBudgetStore(),
});

// createGuardrails() picks up configureBudgets() when no per-agent budget is set
```

| Scope source | Resolves to |
|--------------|-------------|
| `'agentDef'` | `{agentName}:{runId}` when runId present, else agent name |
| `(ctx) => ctx.runId` | Per-run bucket |
| `(ctx) => ctx.orgId` | Per-org bucket |
| `() => 'global'` | Global bucket |

### Breach actions (`BudgetBreachAction`)

`terminate` · `requestApproval` (maps to guardrail `suspend`) · `flag` · `warn`

### Cost accounting

`estimateCostUsd(usage, rates)` — USD from per-1k input/output token rates. Falls back to `totalTokens` when input/output counts are zero.

`AgentStopReason` includes **`cost_budget`** when cost cap is exceeded.

### Store

| Implementation | File |
|----------------|------|
| `InMemoryBudgetStore` | `src/guardrails/budget-store.ts` |
| Custom | Implement `BudgetUsageStore` for Redis/Postgres |

| Method | Behavior |
|--------|----------|
| `getRemainingBudget(scopeName?)` | Sync snapshot for innermost or named scope |
| `getScopeRemaining(name, key)` | Async remaining for explicit scope key (HTTP guards) |
| `getAllBudgets()` | Async status for all configured scopes |
| `recordUsage(usage, providerName?)` | Manual usage recording |
| `reset()` | No-op on shared store (org/global persist) |

### Hooks

| Hook | Behavior |
|------|----------|
| `beforeLlm` (pre) | Increment step counter; check breaches |
| `afterLlm` | Record token usage and estimated USD cost; check breaches |
| `beforeTool` (pre) | Check-only (no step increment) |

**Blocks when usage exceeds cap:**

- `max_steps` → `max_steps`
- `maxTokens` → `token_budget`
- `maxCostUsd` → `cost_budget`

---

## `PromptInjectionGuardrail`

**File:** `src/guardrails/injection.ts`  
**Name:** `prompt-injection`

Detects and mitigates prompt injection in user input, LLM output, and tool results.

### Default settings (`DEFAULT_PROMPT_INJECTION_OPTIONS`)

| Option | Default |
|--------|---------|
| `mode` | `'block'` |
| `strictness` | `'medium'` |
| `scanToolOutputs` | `true` |

### Modes

| Mode | Behavior |
|------|----------|
| `block` | Rejects request with `"I can't process this request"` |
| `flag` | Proceeds; adds `[injection:category:severity]` flags |
| `sanitize` | Wraps/strips matched content; modifies messages or tool output |

### Strictness

| Level | Pattern coverage |
|-------|------------------|
| `low` | Critical patterns only (e.g. ignore instructions) |
| `medium` | Default — balanced coverage |
| `high` | Broader patterns + optional LLM classifier for ambiguous input |

### Detection layers

1. **Pattern rules** — instruction override, jailbreak, exfiltration, indirect injection
2. **Encoding tricks** — base64 and hex payloads decoded and re-scanned
3. **Invisible characters** — requires 3+ zero-width / bidi chars
4. **Output leak** — system prompt substring overlap in model response
5. **Optional model detection** — LLM classifier when `modelDetection.provider` set and heuristics inconclusive

### Hooks

| Hook | Phase |
|------|-------|
| `beforeLlm` (pre) | Scan user messages |
| `afterLlm` | Scan response for prompt leak / tone shift |
| `afterTool` | Scan tool output when `scanToolOutputs: true` |

### Public methods

`checkInput(message)`, `checkOutput(response, systemPrompt)` — return `InjectionDetection` with severity, category, matched patterns, optional `sanitizedContent`.

### Opt out

```ts
createAgent({ guardrails: { promptInjection: false } });
// or disable all guardrails:
createAgent({ guardrails: false });
```

---

## Agent integration

- `Agent` calls `guardrailMiddleware.beforeLlm` / `afterLlm` around each completion
- Tool calls use `beforeTool` / `afterTool`
- `config.guardrails` validators run on input before loop and on final output text
- `checkRunGuardrails` in agent loop enforces step/token/cost from `GuardrailConfig`

---

## Subpath `ottrix/guardrails`

Exports middleware, `createGuardrails`, `configureBudgets`, multi-scope budget types, validators, human approval, **`AuditEmitter`**, legacy **`AuditLogger`**, **`PromptInjectionGuardrail`**, injection types, and guardrail context types.

Root `ottrix` exports `createGuardrails`, `GuardrailMiddleware`, `AuditEmitter`, `useAudit`, `configureBudgets`, `PromptInjectionGuardrail`, and related types.

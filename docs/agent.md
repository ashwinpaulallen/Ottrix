# Agent

Source: `src/agent/`

The **Agent** runs a ReAct-style loop: call the LLM, execute tool calls, append results to context, repeat until a final text response or a stop condition.

## `Agent` class

**File:** `src/agent/agent.ts`  
**Constructor:** `new Agent(config: AgentConfig)`

### Public methods

| Method | Returns | Behavior |
|--------|---------|----------|
| `getName()` | `string` | `config.name` |
| `getReflector()` | `Reflector \| undefined` | `config.reflector` |
| `getToolRegistry()` | `ToolRegistry \| undefined` | Only if `config.toolRegistry` is a `ToolRegistry` instance |
| `run(input)` | `Promise<AgentResult>` | Full loop with steps, reflector, guardrails, optional telemetry span `agent.run` |
| `stream(input)` | `AsyncIterable<AgentEvent>` | Streaming loop; span `agent.stream`; yields `thinking`, `text`, `tool_call`, `tool_result`, `tool_denied`, `done` |

### `run` vs `stream` (implemented differences)

| Feature | `run` | `stream` |
|---------|-------|----------|
| Reflector (`applyReflection`) | Yes | No |
| `result.steps` populated | Yes | Returns `steps: []` |
| `onStep` in final metadata path | Yes | Not recorded in stream result builder |
| Telemetry root span | `agent.run` | `agent.stream` |
| Event types | N/A (returns `AgentResult`) | `thinking`, `text`, `tool_call`, `tool_result`, `tool_denied`, `done` |

### Defaults (constructor)

| Setting | Resolution |
|---------|------------|
| `maxSteps` | `config.maxSteps ?? config.guardrails?.maxSteps ?? 10` |
| `maxTokenBudget` | `config.maxTokenBudget ?? config.guardrails?.maxTokenBudget` |
| Tool registry | If omitted, creates empty `ToolRegistry`; legacy `config.tools[]` registered as `tool_0`, `tool_1`, … |
| Provider | Wrapped with `instrumentProvider` when `config.telemetry` is set |
| Context | `ContextManager` with `contextLimitTokens` and `keepRecentMessages` from config |

### Run loop (high level)

1. `guardrailMiddleware?.reset()`; optional `runRecorder.startRun(input, name)`
2. **Prepare:** system prompt, optional planner + plan validation, memory retrieve (limit **5**), input validators
3. **Per iteration** (up to `maxSteps`):
   - `contextManager.maybeSummarize(messages)`
   - LLM `complete` with guardrail pre/post hooks
   - Record thinking step
   - If text-only response → output validators → response step; reflector may continue, replan, or stop
   - Else execute tool calls (up to **3** attempts per tool with `onError` hook)
   - `checkRunGuardrails` for step/token/cost limits
4. Build `AgentResult` with `metadata.stopReason`, tokens, optional `plan`, `planValidation`, `resultEvaluation`
5. `runRecorder.endRun` on success; `runRecorder.cancelRun` on thrown error

### Stop reasons (`AgentStopReason`)

`completed` · `max_steps` · `token_budget` · `guardrail` · `tool_blocked` · `error` · `aborted`

### Errors thrown

| Error | When |
|-------|------|
| `Error` | Input/output validator failure (message includes validator name) |
| Provider, registry, middleware errors | Propagate uncaught |

There is no dedicated `AgentError` class.

---

## `AgentConfig`

**File:** `src/types/agent.ts`

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent display name |
| `provider` | Yes | `CompletionProvider` instance |
| `toolRegistry` | No | Preferred tool container |
| `tools` | No | **Deprecated** — array registered as `tool_N` |
| `systemPrompt` | No | System instructions |
| `defaultModel` | No | Passed to provider when model omitted in completion params |
| `memory` | No | `MemoryProvider` for RAG-style retrieve |
| `guardrails` | No | `GuardrailConfig` (budgets, validators) |
| `guardrailMiddleware` | No | `GuardrailMiddleware` pipeline |
| `maxSteps` | No | ReAct iteration cap |
| `maxTokenBudget` | No | Cumulative token cap for run |
| `onStep` | No | Called after each agent step |
| `onToolCall` | No | Called before tool execution |
| `onError` | No | `(error, context) => 'retry' \| 'skip' \| 'abort'` |
| `contextLimitTokens` | No | Context window budget (see ContextManager) |
| `keepRecentMessages` | No | Messages preserved during summarization |
| `planner` | No | `Planner` instance |
| `reflector` | No | `Reflector` instance |
| `telemetry` | No | `Telemetry` for spans/metrics |
| `runRecorder` | No | `RunRecorder` for replay |
| `outputSchema` | No | Zod schema for final response validation (requires `zod` peer) |
| `structuredOutputRetries` | No | Re-prompts after failed validation; default **3** (4 total attempts) |
| `observationalMemory` | No | `ObservationalMemory` for user fact extraction |

---

## Structured output (Zod)

**Files:** `src/agent/structured-output.ts`, `src/utils/zod-to-json-schema.ts`

When `outputSchema` is set on `AgentConfig` or passed in `AgentRunOptions`, the agent requires the final LLM text to parse and validate against the schema.

```ts
import { z } from 'zod';

const schema = z.object({ name: z.string(), age: z.number() });
const result = await agent.run('Introduce Ada', { outputSchema: schema });
// result.parsedOutput — typed object when validation succeeds
```

| Behavior | Detail |
|----------|--------|
| Validation | `parseAndValidateStructuredOutput` strips markdown JSON fences before parse |
| Retries | Up to `1 + structuredOutputRetries` attempts; re-prompts model on failure |
| Success | `parsedOutput` populated; `response` is raw model text |
| Failure | Throws `StructuredOutputError` with `attempts`, `lastOutput`, `zodError` |
| Tool loop | Structured validation runs only on final text-only response |

**Exports:** `StructuredOutputError`, `zodToJsonSchema`, `ensureZodPeer`, `ZOD_REQUIRED_MESSAGE`

Peer dependency **`zod`** must be installed for structured output and Zod tools.

---

## Observational memory integration

When `config.observationalMemory` is set, the agent:

1. Injects relevant observations into the system prompt before each run
2. After successful runs, may extract new observations from the conversation (per `extractionInterval`)

See [Memory](./memory.md#observationalmemory) for configuration.

---

## Context manager

**File:** `src/agent/context.ts`  
**Class:** `ContextManager`

| Method | Behavior |
|--------|----------|
| `maybeSummarize(messages)` | If estimated tokens ≥ **85%** of limit, summarizes middle messages; keeps all `system` messages and last `keepRecent` non-system messages |

| Option | Default |
|--------|---------|
| `contextLimitTokens` | `128_000` |
| `keepRecentMessages` | `6` |
| Summarization `maxTokens` | `1024` |
| Summarization `temperature` | `0` |

Token counting uses `provider.countTokens`; on failure falls back to `estimateMessageTokens`. Does not throw.

---

## Planner

**File:** `src/agent/planner.ts`  
**Class:** `Planner`

| Method | Behavior |
|--------|----------|
| `plan(goal)` | `rules` mode → rule-based plan; `llm` mode → JSON plan from provider, falls back to rules on parse failure |
| `validate(plan)` | Checks duplicate ids, unknown/self dependencies, cycles, unreachable steps |
| `replan(goal, completedSteps, partialResults)` | LLM or rule-based revised plan merged with completed steps |
| `formatPlanForContext(plan)` | Markdown block for user message |

| Option | Default |
|--------|---------|
| `mode` | `'llm'` if `provider` set, else `'rules'` |
| `rules` | Built-in research/calculate/write patterns |

**Errors:**

- `Error('Planner requires a CompletionProvider when mode is "llm"')`
- `Error('Plan JSON must include a non-empty steps array')` from `parsePlanFromJson`
- `JSON.parse` failures propagate as `SyntaxError`

**Exported helpers:** `parsePlanFromJson`, `mergeRevisedPlan`

---

## Reflector

**File:** `src/agent/reflector.ts`  
**Class:** `Reflector`

| Method | Behavior |
|--------|----------|
| `evaluateStep(step, goal)` | Lightweight heuristics or LLM JSON; LLM parse failure → lightweight fallback |
| `evaluateResult(result, goal)` | Same pattern |
| `shouldContinue(steps, goal)` | Lightweight if `lightweight` or no provider; else LLM with fallback |

| Option | Default |
|--------|---------|
| `lightweight` | `false` |

**Errors:**

- `Error('Reflector requires a CompletionProvider when lightweight mode is disabled')` when LLM mode without provider

**Exported lightweight helpers:** `evaluateStepLightweight`, `evaluateResultLightweight`, `shouldContinueLightweight`

---

## Run guardrails helper

**File:** `src/agent/guardrails.ts`

`checkRunGuardrails(reflector, steps, goal, guardrails, …)` — stops when:

- `stepIndex >= effectiveMaxSteps`
- Token budget exceeded
- `estimatedCostUsd >= guardrails.maxCostUsd`
- `requireApproval(lastStep)` returns true

Returns `GuardrailCheckResult` with `shouldStop` and `stopReason`. Does not throw.

**Also exported:** `sumTokenUsage`, message builders (`buildAssistantMessage`, `buildToolResultBlock`, …), `extractTextFromContent`, `extractToolUses`, `isTextOnlyResponse`, `serializeToolOutput`

---

## Subpath `agentic-fabric/agent`

Re-exports everything in `src/agent/index.ts` for advanced use (planner, reflector, context, helpers) without pulling the full root barrel.

# Types

Source: `src/types/`

The types package is **type-only** at runtime (no implementations in this folder). Import from `agentic-fabric/types` or the root package re-exports.

## Messages (`messages.ts`)

| Type | Fields |
|------|--------|
| `ChatRole` | `'system' \| 'user' \| 'assistant' \| 'tool'` |
| `TextBlock` | `{ type: 'text'; text: string }` |
| `ImageSource` | `{ type: 'base64' \| 'url'; media_type: string; data: string }` |
| `ImageBlock` | `{ type: 'image'; source: ImageSource }` |
| `ToolUseBlock` | `{ type: 'tool_use'; id; name; input: Record<string, unknown> }` |
| `ToolResultBlock` | `{ type: 'tool_result'; tool_use_id; content: string \| ContentBlock[] }` |
| `ContentBlock` | Union of text, image, tool_use, tool_result |
| `ChatMessage<TMeta>` | `{ role; content: string \| ContentBlock[]; metadata?: TMeta }` |

---

## Provider (`provider.ts`)

| Type | Purpose |
|------|---------|
| `TokenUsage` | `{ inputTokens; outputTokens; totalTokens }` |
| `ProviderConfig` | `{ apiKey?; baseUrl?; defaultModel; maxRetries?; timeout? }` |
| `CompletionParams<TModel>` | Adds optional `responseFormat: 'text' \| 'json'` |
| `CompletionResult<TModel>` | `{ content: ContentBlock[]; model; usage; stopReason: string }` |
| `StreamChunk` | Union of `text_delta`, `tool_use_start`, `tool_use_delta`, `tool_use_end`, `done` |
| `CompletionProvider<TModel>` | `{ complete; stream; countTokens }` |

Stream chunk `done` data: `{ stopReason: string; usage?: TokenUsage }`.

---

## Tools (`tools.ts`)

| Type | Purpose |
|------|---------|
| `JSONSchemaType` | JSON Schema type enum strings |
| `JSONSchema` | Subset schema fields: `type`, `properties`, `required`, `items`, validation keywords, `oneOf`/`anyOf`/`allOf` |
| `ToolMetadata` | Optional `cost`, `latency`, `requiresAuth`, `idempotent`, **`requiresApproval`** |
| `ApprovalRequest` | Tool approval prompt payload |
| `ApprovalResponse` | `{ approved; reason?; modifiedInput? }` |
| `ApprovalHandler` | `(request) => Promise<ApprovalResponse>` |
| `ToolDefinition` | `{ name; description; inputSchema; metadata? }` |
| `ToolErrorDetails` | `{ name; code?; data? }` |
| `ToolResult` | `{ success; output; error?; errorDetails? }` |
| `ToolExecutor` | `{ execute(input): Promise<ToolResult> }` |

---

## Agent (`agent.ts`)

| Type | Purpose |
|------|---------|
| `AgentToolRegistry` | `{ list(); execute(name, input) }` |
| `AgentErrorAction` | `'retry' \| 'skip' \| 'abort'` |
| `AgentStopReason` | See [Agent](./agent.md#stop-reasons-agentstopreason) |
| `AgentEvent` | `{ type: 'thinking' \| 'text' \| 'tool_call' \| 'tool_result' \| 'tool_denied' \| 'done'; data: unknown }` |
| `AgentStepType` | `'thinking' \| 'tool_call' \| 'tool_result' \| 'response'` |
| `AgentStep` | `{ type; content; timestamp; tokenUsage? }` |
| `AgentConfig` | Full agent configuration including `outputSchema`, `observationalMemory` (see [Agent](./agent.md#agentconfig)) |
| `AgentRunOptions` | Per-run overrides (`outputSchema`) |
| `AgentRunMetadata` | `stopReason` required; optional `warning`, `model`, `plan`, `planValidation`, `resultEvaluation` |
| `AgentResult` | `{ response; parsedOutput?; steps; totalTokens; metadata }` |

---

## Memory (`memory.ts`)

| Type | Purpose |
|------|---------|
| `MemorySnapshot` | `{ version: 1; messages: ChatMessage[]; createdAt: number }` |
| `MemoryEntry` | `{ id; content; metadata?; embedding?; timestamp }` |
| `RetrievalOptions` | `{ limit?; threshold?; filter? }` |
| `MemoryProvider` | `{ store; retrieve; clear }` |

---

## Guardrails (`guardrails.ts`)

| Type | Purpose |
|------|---------|
| `ValidationSeverity` | `'info' \| 'warning' \| 'error'` |
| `ValidationResult` | `{ passed; reason?; severity? }` |
| `Validator` | `{ name; validate(content): Promise<ValidationResult> }` |
| `GuardrailConfig` | `maxTokenBudget?`, `maxSteps?`, `maxCostUsd?`, `inputValidators?`, `outputValidators?`, `requireApproval?` |

## Evals (`src/evals/types.ts`)

Import types from `agentic-fabric/evals` or root package:

`EvalDatasetEntry`, `EvalResult`, `ScoreResult`, `EvalReport`, `AggregateScore`, `EvalRunConfig`

## Guardrails injection types (`src/guardrails/injection.ts`)

Export from `agentic-fabric/guardrails`:

`InjectionDetection`, `InjectionGuardrailMode`, `InjectionSeverity`, `InjectionStrictness`, `PromptInjectionGuardrailOptions`

Runtime guardrail **handlers** and middleware types live in `src/guardrails/types.ts` and export from `agentic-fabric/guardrails`.

---

## Root re-exports

`agentic-fabric` also re-exports these type names from the main entry:

`ToolDefinition`, `ToolResult`, `ToolExecutor`, `JSONSchema`, `MemoryProvider`, `MemoryEntry`, `GuardrailConfig`, plus all agent and provider types listed in `src/index.ts`.

---

## Version constant

```ts
import { AGENTIC_FABRIC_VERSION } from 'agentic-fabric';
// '2.0.0' — matches package.json
```

`AGENT_FABRIC_VERSION` is a deprecated alias for the same value.

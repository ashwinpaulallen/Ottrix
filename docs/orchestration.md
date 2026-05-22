# Orchestration

Source: `src/orchestration/`

Multi-agent workflows run one or more `Agent` instances with shared `WorkflowConfig` (timeout, hooks).

## Shared runner

**File:** `src/orchestration/runner.ts`

| Constant | Value |
|----------|-------|
| `DEFAULT_STEP_TIMEOUT_MS` | `120_000` |

### `WorkflowConfig`

| Field | Behavior |
|-------|----------|
| `timeout` | Per-step timeout ms |
| `onStepComplete` | Called after each step |
| `onError` | `'continue'` \| `'abort'` \| void — `abort` rethrows |

### `runAgentStep({ agent, input, ... })`

- Timeout: `timeoutMs ?? config.timeout ?? DEFAULT_STEP_TIMEOUT_MS`
- On error with `onError('abort')` → rethrow
- With `fallback` → returns step with `error` set instead of throwing
- Otherwise throws **`WorkflowTimeoutError`**

### Utilities

- `runWithConcurrency(tasks, concurrency)` — batched parallel execution preserving batch order
- `mergeTokenUsage(usages)` — sums token fields
- `isGoalMet(reflector, result, goal)` — `reflector.evaluateResult(...).goalMet`

### `WorkflowResult`

`finalResult: AgentResult`, `steps: WorkflowStep[]`, merged tokens, `metadata` (workflow-specific keys).

---

## `SequentialWorkflow`

**File:** `src/orchestration/sequential.ts`

**Constructor:** `new SequentialWorkflow(steps: SequentialWorkflowStep[], config?)`

### Step shape

| Field | Description |
|-------|-------------|
| `agent` | `Agent` to run |
| `name?` | Display name override |
| `inputMapper?` | `(context, lastResult?) => string` |
| `reflector?` | Override agent reflector |
| `goal?` | Goal for reflector (default: original workflow input) |

### `run(input)`

1. For each step: resolve input (mapper, else previous `response`, else original input)
2. `runAgentStep`
3. If reflector (`step.reflector ?? agent.getReflector()`) reports goal met → **early termination**
4. Returns last step as `finalResult` with `metadata.workflowSteps`

**Error:** `SequentialWorkflow: no steps executed`

### `SequentialMapperContext`

`originalInput`, `stepIndex`, `steps` (completed workflow steps).

---

## `ParallelWorkflow`

**File:** `src/orchestration/parallel.ts`

**Constructor:** branches with `agent`, `name?`, optional per-branch `timeoutMs` / `fallback`.

| Option | Default |
|--------|---------|
| `concurrency` | `branches.length` |

### `run(input)`

Runs same `input` on all branches in parallel (with concurrency limit).  
**Merge:** optional `merge(steps)` function; default uses first branch result and joins all responses as `[agentName]: response` lines.

**Error:** `ParallelWorkflow: no branches produced results`

---

## `RouterWorkflow`

**File:** `src/orchestration/router.ts`

**Constructor:** `{ agents: Record<string, Agent>, route: WorkflowRouterFn, fallbackAgent? }`

### `run(input)`

1. `routeKey = route(input)`
2. `agent = agents[routeKey] ?? fallbackAgent`
3. **Error** if no agent and no fallback
4. Single step; `agentName` is route key (or resolved fallback name)

---

## `HierarchicalWorkflow`

**File:** `src/orchestration/hierarchical.ts`

**Requires:** `ToolRegistry` on manager agent (constructor throws if missing).

| Option | Default |
|--------|---------|
| `maxDelegations` | `10` |

Registers **`delegate`** `FunctionTool` on manager registry (`onDuplicate: 'overwrite'`).

Schema: `{ worker: string, task: string }` (both required).

### `run(input)`

1. Appends worker list to manager input
2. Runs manager via `runAgentStep`
3. `steps = [...delegationSteps, managerStep]`
4. `metadata.delegations` count

### Delegation execution

- Unknown worker, max delegations exceeded, or worker failure → **tool result string** returned to the manager (same resilience model as {@link SupervisorWorkflow})
- Worker is nested `HierarchicalWorkflow` → `worker.run(task)`
- Else `runAgentStep` on worker agent

---

## `SupervisorWorkflow`

**File:** `src/orchestration/supervisor.ts`

Supervisor delegates to specialist workers via the shared `delegate` tool. Delegation limits, unknown workers, and worker failures return tool errors rather than throwing.

| Option | Default |
|--------|---------|
| `maxDelegationRounds` | `10` |
| `workerTimeout` | `60_000` ms |
| `maxNestedDepth` | `3` |

### `onSupervisorThinking`

Fires **during** the supervisor run loop when a thinking step is recorded — wired through the supervisor agent's `onStep` hook via `createSupervisorThinkingOnStep`. {@link createSupervisor} attaches this automatically; when constructing {@link SupervisorWorkflow} manually, pass the same hook on the supervisor {@link Agent}.

---

## `DAGWorkflow`

**File:** `src/orchestration/dag.ts`

Directed acyclic graph of steps with optional suspend/resume, retries, and concurrency limits. Use {@link DAGBuilder} or YAML `type: dag` via {@link WorkflowLoader}.

---

## `ParallelThenWorkflow`

**File:** `src/orchestration/workflow-loader.ts` (built by loader, not constructed directly in typical use)

Parallel phase → synthesis agent with template default:

`Synthesize the following perspectives:\n\n{{previous}}`

Supports `{{input}}` and `{{previous}}` in step templates.

---

## Workflow definitions and loader

**Files:** `workflow-definition.ts`, `workflow-loader.ts`, `yaml-parse.ts`

### `WorkflowLoader`

**Constructor options:**

| Field | Required |
|-------|----------|
| `providers` | `ProviderRegistry` — resolves agent LLM backends |
| `tools` | Optional `ToolRegistry` for tool references in definitions |

| Method | Behavior |
|--------|----------|
| `loadFromFile(path)` | Read UTF-8 → `parseWorkflowFile` → normalize → build |
| `loadFromObject(def)` | Normalize + validate + build |

Returns `LoadedWorkflow` with `workflow`, `definition`, `describe()`.

### Workflow types (normalized)

| Type | Required shape |
|------|----------------|
| `sequential` | `steps[]` with `agent` name + optional `prompt` / `inputTemplate` |
| `parallel` | `agents[]`; optional `then` synthesis block |
| `router` | `router.type`: `rules` or `llm` |
| `hierarchical` | `manager` + `workers` map |
| `supervisor` | `supervisor` + `workers`; optional `workerDescriptions`, `maxRounds`, `workerTimeout`, `maxNestedDepth`, `synthesizeResults` |
| `dag` | `steps[]` with `id`, `agent`, optional `dependencies`, `suspend`, `retries`, `timeout`, `inputTemplate`; optional `maxConcurrency` |

`LoadedWorkflow.resumeDag(state, input)` resumes a suspended DAG loaded from a definition. Use `dagEngine` / `supervisorEngine` to access the underlying engines.

### Template rendering

`{{input}}` → original workflow input  
`{{previous}}` → previous step response (sequential / parallel-then)  
`{{depId}}` → dependency step output in DAG `inputTemplate` (by step ID)

### Router (`createRouterFn`)

**Rules:** first matching rule (regex with `/pattern/flags` or case-insensitive substring); else `fallback`; **Error** if no match and no fallback.

**LLM:** prompts `llmAgent` to return agent key; trim response; fallback on unknown key; **Error** if `llmAgent` missing.

### Agent resolution

Each agent definition references a provider name from `ProviderRegistry`, optional tools subset, system prompt, model overrides.  
Hierarchical manager gets empty `ToolRegistry` if no tools registry passed to loader.

### Validation errors (`Error`)

Examples: empty workflow name, no agents, unknown agent references, sequential with no steps, parallel duplicates, invalid regex, hierarchical manager as worker, unsupported workflow type.

### `describeWorkflow(definition)`

Returns `WorkflowStructureDescription` with topology-specific fields; parallel+then → `type: 'parallel-then'`.

---

## YAML / JSON parsing

**File:** `src/orchestration/yaml-parse.ts`

| Function | Behavior |
|----------|----------|
| `parseWorkflowFile(path, content)` | `.json` → `JSON.parse`; `.yaml`/`.yml` → `js-yaml` if import succeeds, else `parseYamlSubset` |
| `parseYamlSubset` | Limited YAML: maps, lists, scalars, `#` comments, `\|` multiline |
| `tryImportJsYaml` | Dynamic import; `null` if unavailable |

**Errors:** unsupported extension, parse failures, `YAML parse error: expected mapping/sequence context`.

**Peer dependency:** installing `js-yaml` enables full YAML; without it, subset parser is used.

---

## Exports

### `agentic-fabric/orchestration`

Workflow classes, `WorkflowLoader`, `LoadedWorkflow`, `ParallelThenWorkflow`, runner utilities, definition types, YAML helpers, `WorkflowTimeoutError`.

### Root `agentic-fabric`

`SequentialWorkflow`, `ParallelWorkflow`, `ParallelThenWorkflow`, `RouterWorkflow`, `HierarchicalWorkflow`, `WorkflowLoader`, `LoadedWorkflow` only.

# Run context

Source: `src/context/run-context.ts`

Ottrix propagates request-scoped metadata through **AsyncLocalStorage (ALS)** so agents, tools, guardrails, workflows, and exporters can read tenancy and correlation IDs without explicit parameter threading.

## `RunContext`

| Field | Description |
|-------|-------------|
| `runId` | Stable identifier for an entire agent run or workflow execution |
| `stepId?` | Current step within a run (set by `withStep`) |
| `agentName?` | Agent that owns the current scope |
| `requestId?` | Upstream HTTP or queue message id |
| `[key: string]` | Extensible — apps add `orgId`, `userId`, etc. via `runWith` |

Contexts are **frozen** after merge. Update scope by nesting `runWith()` rather than mutating in place.

## API

| Function | Behavior |
|----------|----------|
| `runWith(ctx, fn)` | Run async/sync `fn` inside merged ALS context |
| `runGeneratorWith(ctx, factory)` | Streaming-safe ALS for async generators (every `next()` stays in context) |
| `withStep(stepId)` | Returns partial context `{ stepId }` for nesting |
| `getRunContext()` | Current context or `undefined` outside a run |
| `requireRunContext()` | Current context or throws `ContextNotAvailableError` |

### Typed extensions

```ts
type AppContext = RunContext.Augment<{ orgId: string }>;
const ctx = RunContext.augment<AppContext>(requireRunContext());
```

## Automatic propagation

Entry points set `runId` and `agentName`:

| Entry | Sets |
|-------|------|
| `Agent.run()` / `Agent.stream()` | `runId` (UUID if unset), `agentName` |
| `DAGWorkflow.run()` | `runId` from option or UUID |
| `DAGWorkflow` step execution | `withStep(stepId)` per step |
| `@ottrix/nestjs` `RunContextInterceptor` | `runId`, `requestId`, `orgId` from headers/user |

Downstream consumers:

- **Budget guardrail** — scopes keyed by `runId`, `orgId`, `agentName`
- **Audit emitter** — every event includes `runContext` snapshot
- **OTEL exporter** — resource attributes grouped by captured run context at export time

## Example

```ts
import { Agent, runWith } from 'ottrix';

const agent = new Agent({ name: 'researcher', provider, maxSteps: 5 });

await runWith({ runId: 'req-42', orgId: 'acme', agentName: 'researcher' }, () =>
  agent.run('Summarize Q1 results'),
);
```

## Subpath exports

`RunContext`, `runWith`, `runGeneratorWith`, `withStep`, `getRunContext`, `requireRunContext`, and `ContextNotAvailableError` are exported from root **`ottrix`**.

## Errors

| Class | When |
|-------|------|
| `ContextNotAvailableError` | `requireRunContext()` or `withStep()` used outside an active ALS scope |

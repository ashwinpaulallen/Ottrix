# Composition

How planner, evaluator, supervisor, DAG, compaction, and HTTP adapters fit together. Each piece stays optional. Types below are the public ones: `AgentConfig`, `Planner`, `EvaluationConfig`, `CreateSupervisorConfig`, `DAGBuilder`, `WorkflowStateStore`, `CompactionConfig`, `ModelCatalog`, `RunContext`.

Related guides: [agent.md](./agent.md), [self-evaluation.md](./self-evaluation.md), [orchestration.md](./orchestration.md), [context.md](./context.md).

## Agent with Planner + Evaluator

`Planner` turns a goal into a `Plan` (`plan()`, then `validate()`). In `rules` mode it matches `PlanningRule` patterns and does not call the model. In `llm` mode it asks a `CompletionProvider` for JSON steps and falls back to rules if parsing fails. The agent does not execute the plan as a graph. Before the ReAct loop it injects `formatPlanForContext()` into the first user message and emits `plan_created` and `plan_validated` (`run()` and `stream()`). A `Reflector` can emit `plan_revised` on both `run()` and `stream()`. Step events (`plan_step_started` / `completed` / `failed`) come only from `executeControlledPlanStep`, when the caller drives the DAG.

`evaluation` on `AgentConfig` builds an `EvaluatorStrategy` through `createEvaluator()`. After a final answer, heuristics run first. An LLM sufficiency check follows unless heuristics are already confident the answer is insufficient. `threshold` is the confidence below which the agent refines. `maxRefinements` caps those extra turns (default `2`, maximum `5`). `criteria` tells the judge what "sufficient" means.

Use the agent loop on its own for a short question or open tool use, where a plan and a judge would only add calls. Add a planner when the goal has ordered parts and the model should see that outline up front. Add an evaluator when the answer must meet explicit criteria and one extra cheap call is acceptable. Use all three for a multi-part task that should start from a plan and stop only when the judge is satisfied. Cost is one planning call (LLM mode only), the ReAct loop, and up to `maxRefinements` evaluation calls.

```ts
import { Agent, Planner, type CompletionProvider } from 'ottrix';

const provider = {} as CompletionProvider;
const planner = new Planner({ mode: 'rules' });

const agent = new Agent({
  name: 'research',
  provider,
  planner,
  maxSteps: 8,
  evaluation: {
    enabled: true,
    threshold: 0.8,
    maxRefinements: 2,
    criteria: ['Cites sources', 'Answers every part of the question'],
  },
});

await agent.run('Compare the two migration plans');
```

## Supervisor + worker isolation

`createSupervisor()` builds a `SupervisorWorkflow`. The supervisor agent receives a roster and a `delegate` tool (`DelegateToolInput`: `worker`, `task`, and optional `context`). Workers do not see the supervisor's message history. `buildWorkerInput()` sends that worker's prior task/response pairs from this run, the distilled `context` string, and the `task`. The tool result returned to the supervisor model is the worker's final `response` text. `SupervisorWorkflow.run()` also keeps a `DelegationRecord` per call, including the full `AgentResult`, for the caller.

`maxRounds` maps to `maxDelegationRounds` (default `10`). Further `delegate` calls in that run return a tool error string. `maxNestedDepth` (default `3`) stops a worker that is itself a `SupervisorWorkflow`. `workerTimeout` (default `60_000` ms) bounds each worker `Agent`.

```ts
import { createSupervisor, type CompletionProvider } from 'ottrix';

const pipeline = createSupervisor({
  provider: {} as CompletionProvider,
  systemPrompt: 'Pass each worker only the facts it needs in delegate.context.',
  maxRounds: 6,
  maxNestedDepth: 2,
  workerTimeout: 30_000,
  workers: {
    researcher: {
      description: 'Finds primary sources',
      systemPrompt: 'Return a short fact list. Omit raw transcripts.',
    },
    writer: {
      description: 'Drafts from the supplied notes',
      systemPrompt: 'Write only from the context and task you are given.',
    },
  },
});
await pipeline.run('Summarize the Q3 outage');
```

## DAG workflow + suspend / resume

A step with `suspend: true` pauses before `execute`. `humanApproval()` from `ottrix/orchestration` sets that flag and an `approvalGate` (`ApprovalGateConfig`: `role`, `onTimeout`, optional `timeoutSec` and `multi`). On suspend the workflow stores an approval request. `resume()` expects an `ApprovalDecision` as `stepOutput` (`approve`, `reject`, or `redirect`). `handleApprovalResume()` checks quorum, timeout, and escalation before the step output is accepted.

`WorkflowStateStore` keeps `SuspendedWorkflowState` so another process can resume:

| Store | Constructor | Peer |
|-------|-------------|------|
| `InMemoryStateStore` | `new InMemoryStateStore()` | none |
| `PostgresStateStore` | `new PostgresStateStore({ connectionString })` | `pg` |
| `RedisStateStore` | `new RedisStateStore({ url })` | `ioredis` |

`workflow.suspendTo(store)` persists on suspend and loads on resume. With a store, `resume()` takes a `ResumeInput` (`workflowId` plus `stepOutput`). Without a store, pass the `suspendedState` from `DAGResult` as the first argument and `ResumeInput` as the second. A workflow id mismatch throws `WorkflowResumeError`.

```ts
import { DAGBuilder, InMemoryStateStore } from 'ottrix';
import { humanApproval, type ApprovalDecision } from 'ottrix/orchestration';

const workflow = new DAGBuilder()
  .addStep('draft', { name: 'Draft', execute: async (input: string) => input })
  .addStep('approve', {
    ...humanApproval({ role: 'editor', onTimeout: 'reject' }),
    dependencies: ['draft'],
  })
  .build()
  .suspendTo(new InMemoryStateStore());

const paused = await workflow.run('ship the changelog');
const decision: ApprovalDecision = {
  action: 'approve',
  approver: { id: 'ada', role: 'editor' },
  timestamp: Date.now(),
};
await workflow.resume({ workflowId: paused.suspendedState!.workflowId, stepOutput: decision });
```

## Agent + compaction + intent

Three `AgentConfig` sections meet at construction:

- `catalog` (`ModelCatalog` from `createModelCatalog()`) resolves a `CompletionIntent` once. Summarization uses `{ role: 'summarization', prefer: 'economy' }` when `compaction` is set and `compaction.provider` is omitted. Evaluation uses `{ role: 'evaluation', prefer: 'economy' }` when evaluation is enabled and `evaluation.model` is omitted. LLM planning uses `{ role: 'planning', prefer: 'balanced' }` when `planner.usesLlm()` is true.
- `compaction` (`CompactionConfig`) chooses how history is folded. `strategy: 'hierarchical'` builds a topic index and a prose digest. `recentMessagesToPreserve` stays verbatim. An explicit `compaction.provider` skips the catalog for summarization.
- The primary `provider` still runs the ReAct loop. Compaction and evaluation calls go to the resolved model.

A long research run can keep a capable model for the loop and a cheap model for digests. Map `summarization:economy` (and `evaluation:economy` if you want the same model to judge) in `intentMap`.

```ts
import { Agent, ProviderRegistry, createModelCatalog, ModelDescriptorSchema, type CompletionProvider } from 'ottrix';

const primary = {} as CompletionProvider;
const cheap = {} as CompletionProvider;
const registry = new ProviderRegistry().register('primary', primary).register('cheap', cheap);
const catalog = createModelCatalog(registry, {
  models: [ModelDescriptorSchema.parse({
    key: 'haiku', provider: 'cheap', model: 'claude-haiku-3.5', displayName: 'Haiku',
    costTier: 'low', preferredFor: ['summarization', 'evaluation'],
  })],
  intentMap: { 'summarization:economy': 'haiku', 'evaluation:economy': 'haiku' },
});
new Agent({
  name: 'research',
  provider: primary,
  catalog,
  contextLimitTokens: 128_000,
  compaction: { strategy: 'hierarchical', recentMessagesToPreserve: 4, maxSummaryTokens: 800 },
  evaluation: { enabled: true, maxRefinements: 1 },
});
```

## Multi-framework deployment

`OttrixModule.forRoot({ http: true })` registers `RunContextInterceptor`. `OttrixModule.forFeature()` registers `CreateAgentConfig` agents and, with `controller: true`, `OttrixController` (default path `chat`). CORS headers from `http.cors` are applied on POST, SSE, health, and OPTIONS.

```ts
import { Module } from '@nestjs/common';
import { OttrixModule } from '@ottrix/nestjs';

@Module({
  imports: [
    OttrixModule.forRoot({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } },
      http: true,
    }),
    OttrixModule.forFeature({
      controller: true,
      controllerPath: 'chat',
      agents: [{ name: 'support', systemPrompt: 'Help the caller.', maxSteps: 6 }],
    }),
  ],
})
export class SupportModule {}
```

`createAgentRouter()` mounts POST, SSE, and health on an Express router. `runContext: true` (the default) runs `runContextMiddleware`, which calls `buildRunContext()` from `ottrix/http` and `runWith()`. Headers become `RunContext`: `x-request-id` or `x-trace-id` is `runId`, `x-org-id` is `orgId`, `x-user-id` is `userId`. The agent and its tools read that scope with `getRunContext()` for the rest of the request. Pass `runContext: false` to skip it, or a partial `ContextExtractors` map to replace a header.

```ts
import express from 'express';
import { createAgentRouter } from '@ottrix/express';
import { Agent, FunctionTool, ToolRegistry, getRunContext, type CompletionProvider } from 'ottrix';

const tools = new ToolRegistry();
tools.register(new FunctionTool({
  name: 'whoami',
  description: 'Read the caller from RunContext',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ orgId: getRunContext()?.orgId, runId: getRunContext()?.runId }),
}));

const agent = new Agent({ name: 'support', provider: {} as CompletionProvider, toolRegistry: tools });
const app = express();
app.use(express.json());
app.use('/chat', createAgentRouter({ agent, runContext: true }));
```

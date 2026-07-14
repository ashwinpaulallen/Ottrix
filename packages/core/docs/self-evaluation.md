# Self-Evaluation in the ReAct Loop

Source: `src/agent/evaluation/`

After each final text response, the agent can evaluate whether it fully addressed
the original request. If not, it automatically refines up to `maxRefinements`
times before returning.

## What it does

Self-evaluation closes the quality gap between “the model stopped” and “the
request was actually answered.” It runs only on **text-only** finals (not mid
tool-loop), and records structured results on `AgentResult.evaluations`.

## How the evaluation works

1. **Heuristic fast-path** — detects obvious problems (hedging without action,
   explicit uncertainty with unused tools, very short responses) without any
   LLM call.
2. **LLM evaluation** — if heuristics pass or are inconclusive, a structured
   LLM call evaluates the response against the original goal.
3. **Refinement** — if insufficient (and confidence ≥ `threshold`), a targeted
   instruction is appended to the conversation and the agent’s ReAct loop
   continues.

## Configuration

```typescript
import { createAgent } from 'ottrix';

const agent = createAgent({
  evaluation: {
    enabled: true,
    threshold: 0.8, // confidence needed to trigger refinement
    maxRefinements: 2, // default: 2. Higher = better quality, more cost
    model: 'claude-haiku-3.5', // use a cheap model for evaluation
    criteria: [
      // optional: domain-specific quality criteria
      'Answers all parts of the question',
      'Provides specific examples when asked',
    ],
    skipIfNoTools: false, // set true for simple Q&A without tools
  },
});
```

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `false` | Turn self-evaluation on |
| `threshold` | `0.8` | Minimum confidence to act on an insufficient result |
| `maxRefinements` | `2` | Cap on refine → re-answer cycles |
| `model` | agent model | Optional cheaper model for eval completions |
| `criteria` | `[]` | Extra quality rules injected into the eval prompt |
| `skipIfNoTools` | `false` | Skip evaluation when the agent has no tools |
| `maxEvalTokens` | `512` | Token budget for the evaluation completion |

`maxSteps` still applies during refinement — evaluation cannot bypass the
step budget.

## Cost model

Each refinement adds approximately one LLM call (the evaluation) plus the
cost of re-running the agent loop. Use a cheap model (`claude-haiku-3.5` or
`gpt-4o-mini`) via `evaluation.model` to minimize evaluation cost.

Rule of thumb: 2 refinements with a cheap eval model adds ~10–15% to
total run cost while significantly improving quality on complex queries.

## Observing evaluations

```typescript
for await (const event of agent.stream('What is quantum computing?')) {
  if (event.type === 'evaluation_result') {
    console.log('Sufficient:', event.data.sufficient);
    console.log('Confidence:', event.data.confidence);
  }
  if (event.type === 'refinement_start') {
    console.log('Refining because:', event.data.missingAspects);
  }
}
```

`AgentResult` also exposes:

- `evaluations` — `EvaluationRecord[]` (`iteration`, `evaluatedAt`, `result`, `durationMs`, optional `tokenUsage`)
- `refinementsUsed` — number of refinements in the run (`0` when evaluation ran but no refine occurred)

### Telemetry & audit

When telemetry is configured:

- Child span `ottrix.agent.evaluation` under `agent.run` / `agent.stream`
- Parent attributes: `ottrix.evaluation.enabled`, `refinements_triggered`, `final_sufficient`, `total_cost_usd`
- Metrics: `evaluation_triggered_total`, `evaluation_refinement_triggered_total`, `evaluation_duration_ms`, `evaluation_confidence`, `evaluation_cost_usd`

When an `AuditEmitter` is registered: event type `agent.evaluation.run` (metadata only — no full response text).

## Public API

```typescript
import {
  createEvaluator,
  CompositeEvaluator,
  HeuristicEvaluator,
  LLMEvaluator,
  buildRefinementInstruction,
  SufficiencyResultSchema,
  EvaluationConfigSchema,
  type SufficiencyResult,
  type EvaluationConfig,
  type EvaluationRecord,
  type EvaluatorStrategy,
  type EvaluationContext,
} from 'ottrix';
```

| Export | Role |
|--------|------|
| `createEvaluator` / `CompositeEvaluator` | Default heuristic → LLM pipeline |
| `HeuristicEvaluator` | Fast-path checks only |
| `LLMEvaluator` | Structured LLM sufficiency judge |
| `buildRefinementInstruction` | Builds the user-role refine message |
| `SufficiencyResultSchema` / `EvaluationConfigSchema` | Zod schemas for validation |

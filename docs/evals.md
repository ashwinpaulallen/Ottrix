# Evals

Source: `src/evals/`

Run agents against labeled datasets and score outputs with pluggable scorers. Produces aggregate statistics and optional CSV/Markdown reports.

## Quick start

```ts
import { evaluate, ExactMatchScorer, ContainsScorer } from 'agentic-fabric/evals';

const report = await evaluate({
  agent,
  dataset: [{ input: 'Capital of France?', expectedOutput: 'Paris' }],
  scorers: [new ExactMatchScorer(), new ContainsScorer(['Paris'])],
});

console.log(report.aggregates.exact_match?.mean);
```

Subpath: `agentic-fabric/evals`  
Also exported from root `agentic-fabric`.

---

## `EvalRunner`

**File:** `src/evals/runner.ts`

| Option | Default |
|--------|---------|
| `name` | Agent name |
| `concurrency` | `3` |
| `provider` | `'default'` (for cost scorers) |

### Constructor validation

- At least one scorer required
- Scorer `name` values must be unique
- `concurrency` must be `>= 1`

### `run()`

1. Runs each dataset entry through `agent.run(input)` (parallel up to `concurrency`)
2. Applies all scorers to `(input, response, expectedOutput?, metadata?)`
3. On agent error → result with `error` set and score `0` for all scorers
4. Returns `EvalReport` with `results`, `aggregates`, `config`, `durationMs`

### `evaluate(options)`

Convenience wrapper: `new EvalRunner(options).run()`.

### Aggregation helpers

| Function | Purpose |
|----------|---------|
| `computeAggregates(results, scorers)` | Mean/min/max per scorer name |
| `aggregateScores(scores)` | Stats for a single scorer across results |

---

## Dataset entries (`EvalDatasetEntry`)

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Prompt passed to `agent.run` |
| `expectedOutput` | No | Reference answer for scorers |
| `tags` | No | Labels for filtering reports |
| `metadata` | No | Extra data passed to scorers (e.g. keywords) |

---

## Scorers

**File:** `src/evals/scorers.ts`

All scorers implement `Scorer`: `{ name, score(input, output, expected?, metadata?) }` → `ScoreResult` with `score` in `[0, 1]`.

| Class | Name | Behavior |
|-------|------|----------|
| `ExactMatchScorer` | `exact_match` | 1 if output equals expected (optional trim) |
| `ContainsScorer` | `contains(kw,...)` | Fraction of keywords found (case-insensitive) |
| `JsonValidityScorer` | `json_validity` | 1 if output parses as JSON |
| `SchemaMatchScorer` | `schema_match` | Validates JSON output against Zod schema |
| `LengthScorer` | `length` | Score by character/token length vs bounds |
| `LatencyScorer` | `latency` | Score from run duration vs target |
| `RegexScorer` | `regex` | 1 if pattern matches output |
| `TokenUsageScorer` | `token_usage` | Score from token counts vs budget |
| `CostScorer` | `cost` | Score from estimated USD vs budget |
| `RelevanceScorer` | `relevance` | LLM grades relevance (requires provider) |
| `CorrectnessScorer` | `correctness` | LLM grades factual correctness |
| `HelpfulnessScorer` | `helpfulness` | LLM grades helpfulness |
| `ToneScorer` | `tone` | LLM grades tone vs target |

**Helpers:** `clampScore`, `parseGradeJson`, `extractJsonCandidate`

LLM scorers call the configured provider with JSON response format and parse `{ score, reason }`.

---

## `EvalReporter`

**File:** `src/evals/reporter.ts`

| Method | Output |
|--------|--------|
| `toMarkdown(report)` | Human-readable summary table |
| `toCsv(report)` | CSV with escaped fields |
| `writeMarkdown(path, report)` | Write file |
| `writeCsv(path, report)` | Write file |

CSV/Markdown escaping handles commas, quotes, and newlines in cell content.

---

## Types (`EvalReport`, `EvalResult`, …)

**File:** `src/evals/types.ts`

- **`EvalResult`:** per-entry input, output, scores map, optional `error`, `durationMs`, token usage
- **`EvalReport`:** `results[]`, `aggregates`, `config`, `durationMs`
- **`AggregateScore`:** `mean`, `min`, `max`, `count` per scorer

---

## Exports

### `agentic-fabric/evals`

`evaluate`, `EvalRunner`, `EvalReporter`, all scorers, types, aggregation helpers.

### Root `agentic-fabric`

Same symbols for convenience imports.

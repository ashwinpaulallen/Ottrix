# @ottrix/typesafe

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

TypeSafe AI / Jev integration for ottrix. Adds fast, typed, probabilistic decisions to your agent — 100ms latency, calibrated confidence, ~300x cheaper than LLM calls for classification tasks.

## What is Jev?

Jev is not an LLM. It's a "System One Model" — optimized for making typed decisions inside software. It can't generate text, but it classifies, scores, routes, and evaluates at ~100ms per call with calibrated confidence scores.

## Installation

```bash
npm install @ottrix/typesafe ottrix @typesafe-ai/sdk
```

Set your API key:

```bash
export TYPESAFE_API_KEY=your_key_here
```

## Use cases

### 1. Fast self-evaluation (replaces LLM evaluator)

```typescript
import { createAgent } from 'ottrix';
import { JevEvaluatorStrategy } from '@ottrix/typesafe';

const agent = createAgent({
  provider: 'anthropic',
  systemPrompt: '...',
  evaluation: {
    enabled: true,
    strategy: new JevEvaluatorStrategy(), // ~100ms, ~$0.000004/eval
    maxRefinements: 2,
  },
});
```

### 2. Injection protection

```typescript
import { JevInjectionGuardrail } from '@ottrix/typesafe';

const guard = new JevInjectionGuardrail({ mode: 'block' });
const detection = await guard.checkInput(userMessage);
if (guard.shouldBlock(detection)) {
  return { error: 'Request blocked' };
}
```

### 3. Agent routing

```typescript
import { JevAgentRouter } from '@ottrix/typesafe';

const router = new JevAgentRouter({
  agents: {
    shopping: { description: 'Helps customers find and buy products' },
    support: { description: 'Handles order issues and complaints' },
    returns: { description: 'Processes returns and refunds' },
  },
  defaultAgent: 'support',
});

const agentName = await router.routeSimple(userMessage); // ~100ms
```

### 4. Fraud pre-screening

```typescript
import { JevDecisionMaker } from '@ottrix/typesafe';

const jev = new JevDecisionMaker();
const { score, recommendation, shouldRunFullAgent } = await jev.scoreFraud({
  orderValue: 299.99,
  cardVelocity: 2,
  isFirstOrder: true,
  addressMatch: false,
});

if (!shouldRunFullAgent && recommendation.value === 'approve') {
  // Fast path — skip the full fraud agent
} else {
  // Confidence low or grey zone — run the full fraud agent
}
```

### 5. Generic decisions

```typescript
const jev = new JevDecisionMaker();

// Boolean
const { value, confidence } = await jev.decide({
  state: { text: articleContent },
  question: 'Is this article suitable for a family audience?',
});

// Classification
const category = await jev.classify({
  state: { email: emailContent },
  question: 'What category is this customer email?',
  options: ['billing', 'technical', 'sales', 'other'],
});

// Score
const quality = await jev.scoreOn({
  state: { response: agentResponse, goal: userGoal },
  question: 'How well does this response address the user goal?',
  maxScore: 10,
});
```

## Confidence thresholds

Every decision includes a calibrated confidence score (0-1). Use it to decide whether to act automatically or escalate:

```typescript
const router = new JevAgentRouter({
  agents: {
    shopping: { description: 'Helps customers find and buy products' },
    support: { description: 'Handles order issues and complaints' },
  },
  defaultAgent: 'support',
  thresholds: {
    autoAct: 0.85, // act without LLM if confidence >= 0.85
    escalate: 0.5, // always escalate to LLM if confidence < 0.50
  },
});
```

## Cost comparison

| Use case        | LLM (Claude Haiku) | Jev             | Savings |
| --------------- | ------------------ | --------------- | ------- |
| Self-evaluation | ~$0.003/call       | ~$0.000004/call | ~750x   |
| Injection guard | ~$0.001/call       | ~$0.000004/call | ~250x   |
| Agent routing   | ~$0.001/call       | ~$0.000004/call | ~250x   |
| Fraud scoring   | ~$0.010/call       | ~$0.000006/call | ~1600x  |

## Exports

| Export                              | Description                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `JevClient`, `createJevClient`      | Typed wrapper around `@typesafe-ai/sdk`               |
| `JevEvaluatorStrategy`              | Sufficiency evaluation via Jev                        |
| `JevInjectionGuardrail`             | Injection detection                                   |
| `JevAgentRouter`                    | Agent routing with a default fallback                 |
| `JevDecisionMaker`                  | Fraud scoring, tool acceptance, and generic decisions |
| `TypeSafeError`, `mapTypeSafeError` | Normalized API errors                                 |
| `DEFAULT_THRESHOLDS`                | `autoAct` 0.85, `escalate` 0.50                       |

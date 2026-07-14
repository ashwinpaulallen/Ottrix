# Per-Capability Token Attribution

## What it does
Every token used in an agent run — main LLM calls, tool executions, self-evaluation,
context summarization — is tracked separately by "capability." The full breakdown
is available on AgentResult.tokenBreakdown.

## Capabilities tracked automatically
- **_llm** — Main agent reasoning calls
- **_evaluation** — Self-evaluation calls (if evaluation is enabled)
- **_summarization** — Context compaction summarization calls
- **tool:name** — Every tool call, using the tool's registered name

## Reading the breakdown
```typescript
import { formatTokenBreakdown } from 'ottrix';

const result = await agent.run('Find the latest news on AI');
if (result.tokenBreakdown) {
  console.log(formatTokenBreakdown(result.tokenBreakdown));
}
```

## Custom capability scopes
If you have code outside the agent loop that makes LLM calls, you can
scope those calls manually:

```typescript
import { withCapabilityScope } from 'ottrix';

const result = await withCapabilityScope('my_preprocessing', async () => {
  return await provider.complete(...);
});
```

## Cost attribution
If the Pricing module is configured, each capability also shows USD cost:
```typescript
const { byCapability, totalCostUsd } = result.tokenBreakdown!;
console.log('Total cost:', totalCostUsd);
console.log('Tool costs:', byCapability['tool:web_search']?.costUsd);
```

# @ottrix/vercel-ai

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Bridge ottrix LLM providers into the [Vercel AI SDK](https://sdk.vercel.ai/) — use ottrix fallback chains, circuit breakers, and cost tracking with `generateText()`, `streamText()`, and UI hooks.

## Install

```bash
npm install @ottrix/vercel-ai ottrix ai
```

## Usage

```typescript
import { generateText } from 'ai';
import { ProviderRegistry } from 'ottrix';
import { createOttrixProvider } from '@ottrix/vercel-ai';

const registry = new ProviderRegistry();
// registry.register('primary', primaryProvider);
// registry.setFallbackChain([{ provider: 'primary' }, { provider: 'backup' }]);

const ottrix = createOttrixProvider(registry);

const { text } = await generateText({
  model: ottrix('claude-sonnet-4-20250514'),
  prompt: 'Hello!',
});
```

### Direct model adapter

```typescript
import { createOttrixModel } from '@ottrix/vercel-ai';

const model = createOttrixModel(myProvider, { modelId: 'gpt-4o' });
```

### Tool conversion

```typescript
import { ottrixToolsToVercel, vercelToolsToOttrix } from '@ottrix/vercel-ai';

const vercelTools = ottrixToolsToVercel(registry.listTools());
const ottrixTools = vercelToolsToOttrix(aiToolSet);
```

## Exports

| Export | Description |
|--------|-------------|
| `createOttrixModel` | `LanguageModelV2` adapter for a single ottrix provider |
| `createOttrixProvider` | Callable Vercel `Provider` backed by `ProviderRegistry` |
| `ottrixToolsToVercel` | `BaseTool[]` → Vercel `Tool` map |
| `vercelToolsToOttrix` | Vercel `Tool` map → `BaseTool[]` |

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | Providers, `ProviderRegistry`, `BaseTool` |
| **`@ottrix/mastra`** | Optional — delegates model layer to this package |
| **`@ottrix/langchain`** | Alternative LangChain.js bridge |

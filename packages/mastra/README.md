# @ottrix/mastra

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Bridge ottrix providers, tools, and agents into [Mastra](https://mastra.ai/) workflows.

## Install

```bash
npm install @ottrix/mastra ottrix @mastra/core
# optional — delegates model adaptation to the Vercel AI SDK bridge
npm install @ottrix/vercel-ai
```

## Usage

### Model adapter

```typescript
import { createOttrixMastraModel } from '@ottrix/mastra';

const model = createOttrixMastraModel(myProvider, { modelId: 'gpt-4o' });
```

When `@ottrix/vercel-ai` is installed, model creation delegates to `createOttrixModel` for full streaming support.

### Tool conversion

```typescript
import { ottrixToolsToMastra, mastraToolsToOttrix } from '@ottrix/mastra';

const mastraTools = ottrixToolsToMastra(ottrixTools);
const backToOttrix = mastraToolsToOttrix(mastraTools);
```

### Agent wrapper

```typescript
import { wrapOttrixAgent } from '@ottrix/mastra';

const mastraAgent = wrapOttrixAgent(ottrixAgent);
const { text } = await mastraAgent.generate('Hello!');
```

The wrapper preserves ottrix RunContext, guardrails, and provider fallback chains by delegating to `agent.run()`.

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | `Agent`, providers, guardrails |
| **`@ottrix/vercel-ai`** | Optional — full streaming model adapter |
| **`@ottrix/langchain`** | Alternative ecosystem bridge |

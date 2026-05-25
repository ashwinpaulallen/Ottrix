# @ottrix/langchain

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Bridge ottrix LLM providers and memory into [LangChain.js](https://js.langchain.com/).

## Install

```bash
npm install @ottrix/langchain ottrix @langchain/core
```

## Chat model

```typescript
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { OttrixChatModel } from '@ottrix/langchain';

const model = new OttrixChatModel({
  provider: myOttrixProvider,
  modelId: 'claude-sonnet-4-20250514',
});

const result = await model.invoke([
  new SystemMessage('You are helpful.'),
  new HumanMessage('Hello!'),
]);
```

Use with a `ProviderRegistry` for fallback chains and circuit breakers — pass the registry as the `provider` (it implements `CompletionProvider`).

## Tools

```typescript
import { ottrixToolsToLangChain, langChainToolsToOttrix } from '@ottrix/langchain';

const lcTools = ottrixToolsToLangChain(registryTools);
const bound = model.bindTools(lcTools);
```

## Memory

```typescript
import { WorkingMemory } from 'ottrix';
import { OttrixMemoryAdapter } from '@ottrix/langchain';

const memory = new WorkingMemory();
const history = new OttrixMemoryAdapter(memory);
```

## Exports

| Export | Description |
|--------|-------------|
| `OttrixChatModel` | `BaseChatModel` adapter with streaming |
| `ottrixToolsToLangChain` / `langChainToolsToOttrix` | Tool conversion |
| `OttrixMemoryAdapter` | `WorkingMemory` ↔ LangChain history |
| Message helpers | `langChainMessagesToOttrix`, `ottrixMessagesToLangChain`, etc. |

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | Providers, tools, `WorkingMemory` |
| **`@ottrix/vercel-ai`** | Vercel AI SDK bridge |
| **`@ottrix/exporter-*`** | Trace export while using LangChain chains |

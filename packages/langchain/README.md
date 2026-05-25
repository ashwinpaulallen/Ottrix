# @ottrix/langchain

> **Status:** Planned — not yet published on npm.

LangChain.js interoperability layer for Ottrix — use Ottrix agents as LangChain runnables, bridge tools, and share memory providers.

---

## Planned features

| Feature | Description |
|---------|-------------|
| `OttrixAgentRunnable` | Wrap an Ottrix `Agent` as a LangChain `Runnable` |
| `toLangChainTools(registry)` | Convert `ToolRegistry` entries to LangChain `StructuredTool` |
| `fromLangChainTool(tool)` | Import LangChain tools into Ottrix |
| Provider bridge | Route LangChain model calls through Ottrix `ProviderRegistry` (fallback, circuit breaker) |

**Peer dependencies (planned):** `ottrix` ≥2.0.0, `langchain` ≥0.3.

---

## Use Ottrix without LangChain today

Ottrix is a standalone framework — you do not need LangChain.js for agents, tools, or workflows:

```bash
npm install ottrix
```

```ts
import { createAgent, createTool } from 'ottrix';
import { z } from 'zod';

const search = createTool({
  name: 'search',
  description: 'Search documents',
  input: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ hits: [] }),
});

const agent = createAgent({
  provider: 'anthropic',
  tools: [search],
});

const { response } = await agent.run('Find docs about budgets');
```

Multi-agent orchestration is built in — see `SequentialWorkflow`, `SupervisorWorkflow`, and `DAGBuilder` in [orchestration docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/orchestration.md).

---

## Links

- [ottrix core package](../core/README.md)
- [Tools docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/tools.md)
- [Orchestration docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/orchestration.md)

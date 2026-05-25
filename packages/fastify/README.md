# @ottrix/fastify

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Thin Fastify adapter for Ottrix — plugin, agent routes, hooks, and error mapping. All agent logic lives in **`ottrix`** core.

Documentation: [docs/README.md](./docs/README.md)

**Peer dependencies:** `ottrix` ≥2.0.0, `fastify` ≥4.0.0

---

## Quick start

```ts
import Fastify from 'fastify';
import { ottrixPlugin, agentRoutes } from '@ottrix/fastify';

const app = Fastify();

await app.register(ottrixPlugin, {
  agents: {
    assistant: { provider: 'anthropic', systemPrompt: 'You are helpful.' },
  },
});

await app.register(agentRoutes, {
  agent: app.ottrix.agents.get('assistant')!,
  prefix: '/chat',
});

await app.listen({ port: 3000 });
```

`POST /chat` runs the agent; `GET /chat/stream?message=...` streams SSE events.

---

## Exports

| API | Purpose |
|-----|---------|
| `ottrixPlugin` | Providers, agents, RunContext / injection / telemetry hooks |
| `agentRoutes` | `POST /` + `GET /stream` with schema validation |
| `mapOttrixError()` | Map Ottrix errors → HTTP status codes |
| `registerOttrixErrorHandler()` | Standalone error handler registration |

---

## Links

- [Integration docs](./docs/README.md)
- [ottrix core](../core/README.md)
- [@ottrix/express](../express/README.md)

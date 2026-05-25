# @ottrix/hono

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Thin Hono adapter for Ottrix — middleware, agent handlers, and error mapping. Works on Node, Bun, Deno, and edge runtimes. All agent logic lives in **`ottrix`** core.

Documentation: [docs/README.md](./docs/README.md)

**Peer dependencies:** `ottrix` ≥2.0.0, `hono` ≥4.0.0

---

## Quick start

```ts
import { Hono } from 'hono';
import { createAgent } from 'ottrix';
import { ottrixContext, ottrixInjection, agentHandler, agentStreamHandler } from '@ottrix/hono';

const app = new Hono();
const agent = createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' });

app.use('*', ottrixContext());
app.post('/chat', ottrixInjection(), agentHandler(agent));
app.get('/chat/stream', agentStreamHandler(agent));

export default app;
```

---

## Exports

| API | Purpose |
|-----|---------|
| `ottrixContext()` | `runWith()` per request (ALS) |
| `ottrixInjection()` | Prompt injection scan on JSON bodies |
| `ottrixTelemetry()` | HTTP spans via `getTelemetry()` |
| `agentHandler()` | POST handler — `agent.run()` → JSON |
| `agentStreamHandler()` | GET handler — `agent.stream()` → SSE |
| `ottrixErrorHandler()` | Map Ottrix errors → HTTP status codes |

---

## Links

- [Integration docs](./docs/README.md)
- [ottrix core](../core/README.md)
- [@ottrix/express](../express/README.md)

# @ottrix/express

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Thin Express adapter for Ottrix — middleware, router factory, SSE streaming, and error mapping. All agent logic lives in **`ottrix`** core.

Documentation: [docs/README.md](./docs/README.md)

**Peer dependencies:** `ottrix` ≥2.0.0, `express` ≥4.18.0

---

## Quick start

```ts
import express from 'express';
import { createAgent } from 'ottrix';
import {
  createAgentRouter,
  runContextMiddleware,
  injectionMiddleware,
  ottrixErrorHandler,
} from '@ottrix/express';

const app = express();
app.use(express.json());

const agent = createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' });

app.use(runContextMiddleware());
app.use('/chat', injectionMiddleware(), createAgentRouter({ agent }));
app.use(ottrixErrorHandler());

app.listen(3000);
```

`POST /chat` runs the agent; `GET /chat/stream?message=...` streams SSE events.

---

## Exports

| API | Purpose |
|-----|---------|
| `createAgentRouter()` | `POST /` + optional `GET /stream` |
| `runContextMiddleware()` | `runWith()` per request (ALS) |
| `telemetryMiddleware()` | HTTP spans via `getTelemetry()` |
| `injectionMiddleware()` | Prompt injection scan on JSON bodies |
| `budgetMiddleware()` | Block when budget guardrails are exceeded |
| `sendAgentStream()` | SSE helper for custom routes |
| `ottrixErrorHandler()` | Map Ottrix errors → HTTP status codes |

---

## Links

- [Integration docs](./docs/README.md)
- [ottrix core](../core/README.md)
- [@ottrix/nestjs](../nestjs/README.md)

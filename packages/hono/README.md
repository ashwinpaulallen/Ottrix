# @ottrix/hono

> **Status:** Planned — not yet published on npm.

Hono middleware for Ottrix agents — lightweight edge and Node.js handlers with run context, guardrails, and streaming.

---

## Planned features

| Feature | Description |
|---------|-------------|
| `ottrixMiddleware()` | Hono middleware for ALS run context and telemetry |
| `createChatHandler(agent)` | `POST` handler returning JSON or SSE |
| Edge-compatible exports | Works on Cloudflare Workers and Node with minimal deps |

**Peer dependencies (planned):** `ottrix` ≥2.0.0, `hono` ≥4.

---

## Use Ottrix with Hono today

```bash
npm install ottrix hono @hono/node-server
```

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { createAgent, runWith } from 'ottrix';

const app = new Hono();
const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

app.post('/chat', async (c) => {
  const { message } = await c.req.json<{ message: string }>();
  const runId = c.req.header('x-run-id') ?? randomUUID();

  const result = await runWith({ runId }, () => agent.run(message));
  return c.json({ response: result.response, runId });
});

serve({ fetch: app.fetch, port: 3000 });
```

---

## Links

- [ottrix core package](../core/README.md)
- [Run context docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/context.md)

# @ottrix/express

> **Status:** Planned — not yet published on npm.

Express middleware and router helpers for Ottrix agents — request-scoped `RunContext`, prompt-injection guards on JSON bodies, streaming responses, and a ready-made `/chat` router.

---

## Planned features

| Feature | Description |
|---------|-------------|
| `ottrixExpress()` | Attach Ottrix telemetry, run context, and guardrails to an Express app |
| `createChatRouter(agent)` | Drop-in router with `POST /chat` and optional SSE streaming |
| `injectionMiddleware()` | Prompt injection scan for `req.body` and `messages[]` arrays |
| `runContextMiddleware()` | Propagate `x-run-id`, `x-request-id`, `x-org-id` into ALS |

**Peer dependencies (planned):** `ottrix` ≥2.0.0, `express` ≥4.

---

## Use Ottrix with Express today

Install the core package and wire a route manually:

```bash
npm install ottrix express
```

```ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createAgent, runWith } from 'ottrix';

const app = express();
app.use(express.json());

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  systemPrompt: 'You are a helpful assistant.',
});

app.post('/chat', async (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }

  const runId = (req.headers['x-run-id'] as string | undefined) ?? randomUUID();

  try {
    const result = await runWith({ runId, requestId: req.headers['x-request-id'] as string }, () =>
      agent.run(message),
    );
    res.json({ response: result.response, runId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(3000);
```

Streaming (without the adapter):

```ts
app.post('/chat/stream', async (req, res) => {
  const { message } = req.body as { message: string };
  res.setHeader('Content-Type', 'text/event-stream');

  for await (const event of agent.stream(message)) {
    if (event.type === 'text') {
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
```

For NestJS, use the published [`@ottrix/nestjs`](../nestjs/README.md) adapter instead.

---

## Links

- [ottrix core package](../core/README.md)
- [Run context docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/context.md)
- [Guardrails docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/guardrails.md)

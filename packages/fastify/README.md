# @ottrix/fastify

> **Status:** Planned — not yet published on npm.

Fastify plugin for Ottrix agents — hooks for run context and telemetry, JSON-schema-friendly route helpers, and SSE streaming.

---

## Planned features

| Feature | Description |
|---------|-------------|
| `fastifyOttrix` plugin | Register Ottrix on a Fastify instance with shared agent config |
| `createChatRoute(agent)` | Typed `POST /chat` handler with guardrails |
| `onRequest` hook | Establish `RunContext` from headers |
| `streamReply(agent, input)` | SSE helper using Fastify reply API |

**Peer dependencies (planned):** `ottrix` ≥2.0.0, `fastify` ≥4.

---

## Use Ottrix with Fastify today

```bash
npm install ottrix fastify
```

```ts
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { createAgent, runWith } from 'ottrix';

const fastify = Fastify();
const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

fastify.post<{ Body: { message: string } }>('/chat', async (request, reply) => {
  const { message } = request.body;
  const runId = (request.headers['x-run-id'] as string | undefined) ?? randomUUID();

  const result = await runWith({ runId }, () => agent.run(message));
  return { response: result.response, runId };
});

await fastify.listen({ port: 3000 });
```

---

## Links

- [ottrix core package](../core/README.md)
- [NestJS adapter](../nestjs/README.md) (published alternative)

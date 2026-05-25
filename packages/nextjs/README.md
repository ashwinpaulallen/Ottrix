# @ottrix/nextjs

> **Status:** Planned — not yet published on npm.

Next.js App Router and Pages Router helpers for Ottrix agents — API route handlers, streaming `Response` utilities, and server-action wrappers.

---

## Planned features

| Feature | Description |
|---------|-------------|
| `createRouteHandler(agent)` | App Router `POST` export for `/api/chat` |
| `streamAgentResponse(agent, input)` | `ReadableStream` compatible with Next.js streaming |
| `withRunContext(headers)` | Map request headers to Ottrix ALS |
| Server Actions helper | Typed wrapper for `'use server'` agent calls |

**Peer dependencies (planned):** `ottrix` ≥2.0.0, `next` ≥14.

---

## Use Ottrix in Next.js today

Install Ottrix in your Next.js app and add an App Router route:

```bash
npm install ottrix
```

`app/api/chat/route.ts`:

```ts
import { createAgent, runWith } from 'ottrix';
import { randomUUID } from 'node:crypto';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  systemPrompt: 'You are a helpful assistant.',
});

export async function POST(request: Request) {
  const { message } = (await request.json()) as { message: string };
  const runId = request.headers.get('x-run-id') ?? randomUUID();

  const result = await runWith({ runId }, () => agent.run(message));
  return Response.json({ response: result.response, runId });
}
```

Streaming route:

```ts
export async function POST(request: Request) {
  const { message } = (await request.json()) as { message: string };
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for await (const event of agent.stream(message)) {
        if (event.type === 'text') {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
```

---

## Links

- [ottrix core package](../core/README.md)
- [Examples](https://github.com/ashwinpaulallen/ottrix/tree/main/examples)

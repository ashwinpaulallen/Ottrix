# @ottrix/nextjs

Drop an ottrix agent into any Next.js app. App Router Route Handlers, Server Actions, middleware injection guards, and Vercel AI SDK-compatible streaming.

**Version:** 0.1.0 · **Requires:** `ottrix` ≥2.0.0 · **Node:** ≥20 · **License:** MIT

---

## Install

```bash
npm install @ottrix/nextjs ottrix next
```

`next` is an optional peer for middleware types — Route Handlers use standard Web `Request`/`Response` only.

---

## Quick start (3 lines)

```ts
// app/api/chat/route.ts
import { createAgentHandlers } from '@ottrix/nextjs';
import { createAgent } from 'ottrix';

const agent = createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' });
export const { POST, GET, OPTIONS } = createAgentHandlers({ agent });
```

That gives you:

- `POST /api/chat` — send `{ message: "..." }`, get JSON `AgentResult`
- `GET /api/chat?message=...` — SSE streaming
- `OPTIONS /api/chat` — CORS preflight
- Prompt injection protection (on by default)
- RunContext per request (Node.js runtime)

---

## Route Handler factories

| Export | Purpose |
|--------|---------|
| `createPostHandler(options)` | JSON `POST` handler |
| `createStreamHandler(options)` | SSE `GET` handler (`?message=`) |
| `createAgentHandlers(options)` | `{ POST, GET, OPTIONS }` bundle |
| `createHealthHandler({ registry? })` | Provider health check |
| `createChatHandler(options)` | Vercel AI SDK `useChat` streaming `POST` |
| `createAIStreamResponse(agent, message)` | Low-level data-stream `Response` |

### Options

```ts
interface AgentHandlerOptions {
  agent: Agent;
  bodyField?: string;              // default 'message'
  injection?: 'block' | 'flag' | false;  // default 'block'
  cors?: boolean;                  // default true
  runContext?: boolean;            // default true (Node.js only)
  queryField?: string;             // default 'message'
}
```

Separate routes (contract-compatible layout):

```ts
// app/chat/route.ts
export const POST = createPostHandler({ agent });

// app/stream/route.ts
export const GET = createStreamHandler({ agent });

// app/health/route.ts
export const GET = createHealthHandler({ registry });
```

---

## With Vercel AI SDK `useChat`

```ts
// app/api/chat/route.ts
import { createChatHandler } from '@ottrix/nextjs';
import { createAgent } from 'ottrix';

const agent = createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' });
export const POST = createChatHandler({ agent });
```

```tsx
// app/page.tsx
'use client';
import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => (
        <div key={m.id}>{m.content}</div>
      ))}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
```

Uses the Vercel AI data-stream wire format — no `ai` package required on the server.

For full Vercel AI SDK provider integration, see [`@ottrix/vercel-ai`](../vercel-ai/README.md).

---

## Middleware (injection guard for all API routes)

```ts
// middleware.ts
import { createOttrixMiddleware, ottrixMatcher } from '@ottrix/nextjs';

export default createOttrixMiddleware({ injection: { mode: 'block' } });
export const config = ottrixMatcher;
```

Regex pattern matching only — edge-safe, no LLM calls in middleware.

---

## Server Actions

```ts
// app/actions.ts
'use server';
import { runAgent } from '@ottrix/nextjs';
import { createAgent } from 'ottrix';

const agent = createAgent({ provider: 'anthropic' });

export async function chat(message: string) {
  return runAgent(agent, message);
}
```

---

## Runtime compatibility

| Feature | Node.js Runtime | Edge Runtime |
|---------|-----------------|--------------|
| POST handler | ✓ | ✓ |
| SSE streaming | ✓ | ✓ |
| RunContext (ALS) | ✓ | ✗ (skipped) |
| Injection guard | ✓ | ✓ (regex only) |
| Health check | ✓ | ✓ |
| Middleware injection | ✓ | ✓ |

RunContext uses AsyncLocalStorage (`node:async_hooks`) and is automatically skipped on Edge.

---

## Links

- [ottrix core package](../core/README.md)
- [Shared HTTP utilities (`ottrix/http`)](https://github.com/ashwinpaulallen/ottrix/tree/main/packages/core/src/http)
- [Examples](https://github.com/ashwinpaulallen/ottrix/tree/main/examples)

[MIT](https://github.com/ashwinpaulallen/ottrix/blob/main/LICENSE) © [ashwinpaulallen](https://github.com/ashwinpaulallen)

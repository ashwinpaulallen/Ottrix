# @ottrix/vercel-ai

> **Status:** Planned — not yet published on npm.

Adapter between Ottrix agents and the [Vercel AI SDK](https://sdk.vercel.ai/) — `streamText`-compatible streams, tool-call bridging, and UI message helpers.

---

## Planned features

| Feature | Description |
|---------|-------------|
| `toVercelStream(agent, input)` | Convert `Agent.stream()` to Vercel AI SDK stream format |
| `ottrixProvider()` | Expose Ottrix `ProviderRegistry` as a Vercel AI custom provider |
| Tool bridge | Map Ottrix `ToolRegistry` tools to Vercel AI tool definitions |
| React hooks helpers | Optional utilities for `useChat` with Ottrix-backed routes |

**Peer dependencies (planned):** `ottrix` ≥2.0.0, `ai` (Vercel AI SDK) ≥3.

---

## Use Ottrix with Vercel AI SDK today

Run Ottrix on the server and adapt events manually until this package ships:

```bash
npm install ottrix ai
```

API route (`app/api/chat/route.ts`):

```ts
import { createAgent } from 'ottrix';

const agent = createAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function POST(req: Request) {
  const { messages } = await req.json();
  const lastUser = [...messages].reverse().find((m: { role: string }) => m.role === 'user');
  const input = lastUser?.content ?? '';

  const { response } = await agent.run(input);
  return Response.json({ role: 'assistant', content: response });
}
```

For native Ottrix streaming without the Vercel AI SDK, use `agent.stream()` directly (see [nextjs adapter](../nextjs/README.md) patterns).

---

## Links

- [ottrix core package](../core/README.md)
- [Vercel AI SDK docs](https://sdk.vercel.ai/docs)

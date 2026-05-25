# @ottrix/fastify

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md) · **Adapter comparison:** [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)

Thin Fastify adapter for Ottrix — plugin, agent routes, hooks, and error mapping. Shared HTTP logic lives in **`ottrix/http`**.

Documentation: [docs/README.md](./docs/README.md)

**Peer dependencies:** `ottrix` ≥2.0.0, `fastify` ≥4.0.0

---

## Quick start

```ts
import Fastify from 'fastify';
import { createAgent } from 'ottrix';
import { ottrixPlugin, agentRoutes } from '@ottrix/fastify';

const app = Fastify();
await app.register(ottrixPlugin);
await app.register(agentRoutes, {
  prefix: '/chat',
  agent: createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' }),
});
await app.listen({ port: 3000 });
```

**Runnable example:** [examples/http-agents/fastify-agent](../../examples/http-agents/fastify-agent/)

---

## What you get by default

| Feature | Default | Behavior |
|---------|---------|----------|
| POST agent run | on | `POST /chat` → JSON `AgentResult` |
| SSE streaming | on | `GET /chat/stream?message=…` |
| RunContext (ALS) | on | `onRequest` hook via `ottrixPlugin` |
| Injection guard | `block` | Scans mutating JSON requests |
| Telemetry spans | on | HTTP spans via `ottrixPlugin` |
| Error mapping | on | Global error handler via plugin |
| CORS | on | `onRequest` hook + `OPTIONS /chat` → 204 |
| Health check | on | `GET /chat/health` (uses `fastify.ottrix.providers` or `registry` option) |
| Graceful shutdown | on | `onClose` flushes observability |

---

## How to customize

**Disable plugin features:**

```ts
await app.register(ottrixPlugin, {
  injection: false,
  runContext: false,
  telemetry: false,
});
```

**Disable route features:**

```ts
await app.register(agentRoutes, {
  prefix: '/chat',
  agent,
  streaming: false,
  cors: false,
  healthCheck: false,
  bodyField: 'prompt',
});
```

**Create agents via plugin** (optional — or pass your own `Agent`):

```ts
await app.register(ottrixPlugin, {
  agents: {
    assistant: { provider: 'anthropic', systemPrompt: 'You are helpful.' },
  },
});
const agent = app.ottrix.agents.get('assistant')!;
```

**Standalone error handler** (without full plugin):

```ts
import { registerOttrixErrorHandler } from '@ottrix/fastify';

registerOttrixErrorHandler(app);
```

See [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md) for request/response/SSE/error formats.

---

## API reference

| Export | Description |
|--------|-------------|
| `ottrixPlugin(options?)` | Registers providers, agents, RunContext, injection, telemetry, error handler |
| `agentRoutes(options)` | Fastify plugin: POST, SSE `/stream`, health, CORS OPTIONS |
| `registerOttrixErrorHandler(app)` | Standalone Ottrix error → HTTP mapping |
| `mapOttrixError(error)` | Re-export from `ottrix/http` |
| `OttrixPluginOptions` | Plugin config (`agents`, `providers`, `injection`, `runContext`, `telemetry`) |
| `AgentRoutesOptions` | Route config (`agent`, `path`, `streaming`, `cors`, `healthCheck`, `registry`, `bodyField`) |
| `OttrixProviderOptions` | Provider registry setup options |
| `OttrixFastifyState` | `fastify.ottrix` decoration type |

---

## Contract tests

```ts
import { runAdapterContractTests } from 'ottrix/testing';
```

See `tests/contract.test.ts` for a full Fastify harness example.

---

## Links

- [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)
- [Integration docs](./docs/README.md)
- [ottrix core](../core/README.md)
- [@ottrix/express](../express/README.md) · [@ottrix/hono](../hono/README.md) · [@ottrix/nestjs](../nestjs/README.md)

# @ottrix/hono

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md) · **Adapter comparison:** [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)

Thin Hono adapter for Ottrix — one-call setup, middleware, handlers, and error mapping. Shared HTTP logic lives in **`ottrix/http`**. Works on Node, Bun, Deno, and edge runtimes.

Documentation: [docs/README.md](./docs/README.md)

**Peer dependencies:** `ottrix` ≥2.0.0, `hono` ≥4.0.0

---

## Quick start

```ts
import { Hono } from 'hono';
import { createAgent } from 'ottrix';
import { ottrix } from '@ottrix/hono';

const app = new Hono();
app.route('/chat', ottrix({
  agent: createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' }),
}));
export default app;
```

**Runnable example:** [examples/http-agents/hono-agent](../../examples/http-agents/hono-agent/)

---

## What you get by default

| Feature | Default | Behavior |
|---------|---------|----------|
| POST agent run | on | `POST /chat` → JSON `AgentResult` |
| SSE streaming | on | `GET /chat/stream?message=…` |
| RunContext (ALS) | on | `ottrixContext()` middleware |
| Injection guard | `block` | `ottrixInjection()` middleware |
| Error mapping | on | Sub-app `onError(ottrixErrorHandler())` |
| CORS | on | `corsMiddleware()` + `OPTIONS /chat` → 204 |
| Health check | on | `GET /chat/health` (requires `registry` option) |

---

## How to customize

**Disable features on the sub-app:**

```ts
ottrix({
  agent,
  streaming: false,
  cors: false,
  healthCheck: false,
  injection: false,
  runContext: false,
  bodyField: 'prompt',
  registry: myRegistry,
});
```

**Compose middleware manually:**

```ts
import {
  ottrixContext,
  ottrixInjection,
  ottrixTelemetry,
  corsMiddleware,
  agentHandler,
  agentStreamHandler,
  ottrixHealth,
  ottrixErrorHandler,
} from '@ottrix/hono';

const sub = new Hono();
sub.use('*', ottrixContext());
sub.use('*', ottrixInjection({ mode: 'flag' }));
sub.use('*', corsMiddleware());
sub.post('/', agentHandler(agent));
sub.get('/stream', agentStreamHandler(agent));
sub.onError(ottrixErrorHandler());
```

**Edge deployment:** export the Hono app as default — no Node-specific code required in your route module.

See [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md) for request/response/SSE/error formats.

---

## API reference

| Export | Description |
|--------|-------------|
| `ottrix(options)` | Pre-configured sub-app with routes and middleware |
| `ottrixContext(extractors?)` | RunContext middleware — `runWith()` per request |
| `ottrixInjection({ mode?, bodyField? })` | Prompt injection scan on JSON bodies |
| `ottrixTelemetry()` | HTTP telemetry span middleware |
| `corsMiddleware()` | CORS headers on all responses |
| `agentHandler(agent, { bodyField? })` | POST handler — `agent.run()` → JSON |
| `agentStreamHandler(agent)` | GET handler — `agent.stream()` → SSE |
| `ottrixHealth({ registry? })` | Provider health check handler |
| `ottrixErrorHandler()` | Hono error handler — maps via `ottrix/http` |
| `mapOttrixError(error)` | Re-export from `ottrix/http` |
| `OttrixOptions` | Options for `ottrix()` |
| `OttrixContextOptions` | RunContext extractor overrides |
| `OttrixInjectionOptions` | Injection guard options |
| `OttrixTelemetryOptions` | Telemetry middleware options |
| `AgentHandlerOptions` | POST handler options |
| `AgentStreamHandlerOptions` | SSE handler options |
| `OttrixHealthOptions` | Health handler options |
| `OttrixEnv` / `OttrixVariables` | Hono context types for RunContext |

---

## Contract tests

```ts
import { runAdapterContractTests } from 'ottrix/testing/contract';
```

See `tests/contract.test.ts` for a full Hono harness example.

---

## Links

- [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)
- [Integration docs](./docs/README.md)
- [ottrix core](../core/README.md)
- [@ottrix/express](../express/README.md) · [@ottrix/fastify](../fastify/README.md) · [@ottrix/nestjs](../nestjs/README.md)

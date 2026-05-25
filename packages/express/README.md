# @ottrix/express

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md) · **Adapter comparison:** [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)

Thin Express adapter for Ottrix — router factory, middleware, SSE streaming, and error mapping. Shared HTTP logic lives in **`ottrix/http`**.

Documentation: [docs/README.md](./docs/README.md)

**Peer dependencies:** `ottrix` ≥2.0.0, `express` ≥4.18.0

---

## Quick start

```ts
import express from 'express';
import { createAgent } from 'ottrix';
import { createAgentRouter } from '@ottrix/express';

const app = express();
app.use(express.json());
app.use('/chat', createAgentRouter({
  agent: createAgent({ provider: 'anthropic', systemPrompt: 'You are helpful.' }),
}));
app.listen(3000);
```

**Runnable example:** [examples/http-agents/express-agent](../../examples/http-agents/express-agent/)

---

## What you get by default

Mounting `createAgentRouter` enables all of the following unless you pass explicit `false`:

| Feature | Default | Route / behavior |
|---------|---------|------------------|
| POST agent run | on | `POST /chat` → JSON `AgentResult` |
| SSE streaming | on | `GET /chat/stream?message=…` |
| RunContext (ALS) | on | Reads `x-request-id`, `x-org-id`, `x-user-id` |
| Injection guard | `block` | Scans JSON body before handler |
| Error mapping | on | `mapOttrixError` via router error handler |
| CORS | on | Headers on all responses + `OPTIONS /chat` → 204 |
| Health check | on | `GET /chat/health` (requires `registry` option) |

---

## How to customize

**Disable features:**

```ts
createAgentRouter({
  agent,
  streaming: false,
  cors: false,
  healthCheck: false,
  injection: false,
  runContext: false,
});
```

**Custom RunContext extractors:**

```ts
import { runContextMiddleware } from '@ottrix/express';

app.use(runContextMiddleware({
  orgId: (headers) => headers['x-tenant-id'],
}));
```

**Explicit middleware stack** (instead of the all-in-one router):

```ts
import {
  runContextMiddleware,
  telemetryMiddleware,
  injectionMiddleware,
  ottrixErrorHandler,
} from '@ottrix/express';

app.use(runContextMiddleware());
app.use(telemetryMiddleware());
app.use(injectionMiddleware({ mode: 'flag' }));
// … your routes …
app.use(ottrixErrorHandler());
```

**Graceful shutdown:**

```ts
import { gracefulShutdown } from '@ottrix/express';

const server = app.listen(3000);
gracefulShutdown(server, { onShutdown: () => getTelemetry().shutdown() });
```

See [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md) for request/response/SSE/error formats.

---

## API reference

| Export | Description |
|--------|-------------|
| `createAgentRouter(options)` | All-in-one router: POST, SSE, health, CORS, RunContext, injection, errors |
| `runContextMiddleware(extractors?)` | Establishes `RunContext` per request via ALS |
| `telemetryMiddleware()` | Wraps requests in Ottrix telemetry spans |
| `injectionMiddleware({ mode?, bodyField? })` | Prompt injection scan on JSON bodies |
| `ottrixErrorHandler()` | Express error middleware — maps errors via `ottrix/http` |
| `gracefulShutdown(server, options?)` | SIGINT/SIGTERM handler with drain timeout |
| `AgentRouterOptions` | Type for router options |
| `RunContextMiddlewareOptions` | Type alias for `Partial<ContextExtractors>` |
| `InjectionMiddlewareOptions` | `{ mode?: 'block' \| 'flag'; bodyField?: string }` |
| `TelemetryMiddlewareOptions` | Telemetry middleware options |
| `GracefulShutdownOptions` | `{ timeout?: number; onShutdown?: () => Promise<void> }` |

---

## Contract tests

```ts
import { runAdapterContractTests } from 'ottrix/testing';
```

See `tests/contract.test.ts` for a full Express harness example.

---

## Links

- [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)
- [Integration docs](./docs/README.md)
- [ottrix core](../core/README.md)
- [@ottrix/fastify](../fastify/README.md) · [@ottrix/hono](../hono/README.md) · [@ottrix/nestjs](../nestjs/README.md)

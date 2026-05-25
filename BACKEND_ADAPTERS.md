# Backend HTTP adapters

Ottrix ships four first-party HTTP adapters that expose the **same API surface** and **identical response formats**. Shared logic lives in [`ottrix/http`](packages/core/src/http/index.ts) — body parsing, RunContext, SSE wire format, error mapping, health checks, and CORS.

**Pick your framework.** The client contract does not change.

| Package | Framework | Best for |
|---------|-----------|----------|
| [`@ottrix/express`](packages/express/README.md) | Express 4+ | Existing Express apps, minimal middleware |
| [`@ottrix/fastify`](packages/fastify/README.md) | Fastify 4+ | High-throughput Node APIs, plugin ecosystem |
| [`@ottrix/hono`](packages/hono/README.md) | Hono 4+ | Edge runtimes (Cloudflare, Bun, Deno) and Node |
| [`@ottrix/nestjs`](packages/nestjs/README.md) | NestJS 10+ | DI, guards, interceptors, Terminus health |

**Runnable examples:** [`examples/http-agents/`](examples/http-agents/)

---

## Feature matrix

| Feature | Express | Fastify | Hono | NestJS |
|---------|:-------:|:-------:|:----:|:------:|
| POST endpoint | ✓ | ✓ | ✓ | ✓ |
| SSE streaming | ✓ | ✓ | ✓ | ✓ |
| RunContext (ALS) | ✓ | ✓ | ✓ | ✓ |
| Injection guard | ✓ | ✓ | ✓ | ✓ |
| Error mapping | ✓ | ✓ | ✓ | ✓ |
| Health check | ✓ | ✓ | ✓ | ✓ |
| CORS | ✓ | ✓ | ✓ | ✓ |
| Graceful shutdown | ✓ | ✓ | —¹ | ✓ |
| DI integration | — | — | — | ✓ |
| Edge runtime | — | — | ✓ | — |

**Defaults-on:** injection blocking, RunContext, CORS, streaming, and error mapping are enabled unless you pass explicit `false` or compose middleware yourself.

¹ Hono runs on edge platforms — use the host runtime's lifecycle hooks for drain/shutdown (see [hono-agent example](examples/http-agents/hono-agent/README.md)).

---

## Setup (side by side)

Mount at `/chat` for all examples below. Adjust the prefix freely — routes are relative to the mount point.

### Express (~6 lines)

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

### Fastify

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

### Hono

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

### NestJS (zero-config)

```ts
import { Module } from '@nestjs/common';
import { OttrixModule } from '@ottrix/nestjs';

@Module({
  imports: [
    OttrixModule.forRoot({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
      http: true,
    }),
    OttrixModule.forFeature({
      agents: [{ name: 'default', systemPrompt: 'You are helpful.' }],
      controller: true,
    }),
  ],
})
export class AppModule {}
```

See [`examples/http-agents/`](examples/http-agents/) for full runnable projects.

---

## API endpoints

When mounted at `/chat` (default `path: '/'` on the router/sub-app):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Run agent synchronously → JSON |
| `GET` | `/chat/stream?message=…` | Stream agent events → SSE |
| `GET` | `/chat/health` | Provider registry health (requires registry) |
| `OPTIONS` | `/chat` | CORS preflight (when CORS enabled) |

**RunContext headers** (optional, read by all adapters):

| Header | Maps to |
|--------|---------|
| `x-request-id` | `RunContext.runId` |
| `x-org-id` | `RunContext.orgId` |
| `x-user-id` | `RunContext.userId` |

Custom extractors are supported — see each adapter README.

---

## Request formats

### POST — run agent

**Request**

```http
POST /chat HTTP/1.1
Content-Type: application/json

{ "message": "What is TypeScript?" }
```

**Success — `200 OK`**

```json
{
  "response": "TypeScript is a typed superset of JavaScript…",
  "steps": [],
  "totalTokens": { "inputTokens": 12, "outputTokens": 48, "totalTokens": 60 },
  "metadata": { "stopReason": "completed" }
}
```

**Validation errors — `400 Bad Request`**

```json
{ "error": "Missing 'message' field in request body" }
```

Other validation messages: `"Request body is empty"`, `"Field 'message' must be a string"`, `"Field 'message' must not be empty"`.

Custom body field: pass `bodyField: 'prompt'` → `{ "prompt": "…" }`.

---

## SSE format

**Request**

```http
GET /chat/stream?message=Hello HTTP/1.1
Accept: text/event-stream
```

**Response — `200 OK`**

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

**Wire format** (from `ottrix/http`):

```
event: text
data: {"text":"Hello "}
id: 0

event: text
data: {"text":"world"}
id: 1

event: done
data: {"stopReason":"completed","response":"Hello world","totalTokens":{...}}
id: 2
```

**Event types:** `text`, `tool_call`, `tool_result`, `done`, `error`

**Keepalive:** SSE comments `: keepalive` sent during slow streams.

**Empty query — `400`** (JSON, not SSE):

```json
{ "error": "Field 'message' must not be empty" }
```

---

## Error format

All adapters map Ottrix errors through [`mapOttrixError`](packages/core/src/http/errors.ts):

```json
{ "error": "Human-readable message", "code": "machine_code", "details": {} }
```

| Condition | Status | `code` | Notes |
|-----------|--------|--------|-------|
| Prompt injection (block mode) | 403 | `injection_detected` | `"Request blocked"` — scans `POST` body **and** `GET /stream?message=` |
| Validation (body/field) | 400 | — | `{ "error": "…" }` only |
| Provider rate limit | 429 | `rate_limit` | `Retry-After` header |
| Provider auth failure | 502 | `auth_error` | Sanitized message |
| Circuit open | 503 | `circuit_open` | `Retry-After` header |
| Budget exhausted | 429 | `budget_exhausted` | |
| Structured output failure | 422 | `structured_output_error` | `details.issues` |
| Generic / unknown | 500 | `internal_error` | `"Internal server error"` — no stack traces |

---

## Health check

**Request:** `GET /chat/health`

**Success — `200 OK`** (requires a `ProviderRegistry`):

```json
{
  "status": "healthy",
  "providers": {
    "anthropic": { "status": "up", "latencyMs": 42 }
  },
  "uptime": 3600,
  "timestamp": "2026-05-25T12:00:00.000Z"
}
```

**Without registry — `503`:**

```json
{
  "error": "Provider registry is required for health checks",
  "code": "missing_registry"
}
```

NestJS: use `OttrixModule.forRoot` (registry included). Express/Hono/Fastify: pass `registry` to the router/plugin options.

---

## CORS

When enabled (default), responses include:

- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Methods` (includes `POST`, `GET`, `OPTIONS`)
- `Access-Control-Allow-Headers`

`OPTIONS /chat` → `204 No Content` with the same headers.

Disable with `cors: false` (Express, Fastify, Hono router options).

NestJS: set `http: { cors: false }` on `OttrixModule.forRoot` / `forRootAsync`. When disabled, `OttrixController` skips CORS headers on its `OPTIONS` handler.

---

## Graceful shutdown

| Adapter | Mechanism |
|---------|-----------|
| Express | `gracefulShutdown(server)` — SIGINT/SIGTERM, drain timeout |
| Fastify | `onClose` hook — flushes `shutdownObservability()` |
| Hono | Platform-specific (see example READMEs) |
| NestJS | `OttrixLifecycleService` — telemetry flush on module destroy |

---

## Contract & parity tests

Every adapter runs the shared contract tests from `ottrix/testing`:

```ts
import { runAdapterContractTests } from 'ottrix/testing/contract';
```

Cross-adapter **parity tests** live in [`packages/integration-tests/tests/adapter-parity.test.ts`](packages/integration-tests/tests/adapter-parity.test.ts) (`@ottrix/integration-tests`).

---

## Further reading

| Resource | Link |
|----------|------|
| Express adapter | [packages/express/README.md](packages/express/README.md) |
| Fastify adapter | [packages/fastify/README.md](packages/fastify/README.md) |
| Hono adapter | [packages/hono/README.md](packages/hono/README.md) |
| NestJS adapter | [packages/nestjs/README.md](packages/nestjs/README.md) |
| `ottrix/http` source | [packages/core/src/http/](packages/core/src/http/) |
| Runnable examples | [examples/http-agents/](examples/http-agents/) |

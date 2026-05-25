# @ottrix/nestjs

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md) · **Adapter comparison:** [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)

Thin **NestJS adapter** for [Ottrix](https://github.com/ashwinpaulallen/ottrix) — dependency injection, lifecycle hooks, HTTP interceptors, guards, SSE streaming, and health checks. Shared HTTP logic lives in **`ottrix/http`**.

**Version:** 0.1.0 · **Requires:** `ottrix` ≥2.0.0 · **Node:** ≥20 · **License:** MIT

Documentation: [docs/README.md](./docs/README.md) · Full guide: [docs/guide.md](./docs/guide.md)

---

## Install

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

**Optional peers:** `@nestjs/terminus` (Terminus health integration)

---

## Quick start (zero-config)

```typescript
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
      controller: true, // POST /chat, GET /chat/stream, GET /chat/health
    }),
  ],
})
export class AppModule {}
```

**Runnable example:** [examples/http-agents/nestjs-agent](../../examples/http-agents/nestjs-agent/)

---

## What you get by default

With `OttrixModule.forRoot({ http: true })` and `OttrixController` (or explicit wiring):

| Feature | Default | NestJS mechanism |
|---------|---------|------------------|
| POST agent run | on | `@Post()` → JSON `AgentResult` |
| SSE streaming | on | `@Sse('stream')` → `Observable<MessageEvent>` |
| RunContext (ALS) | on | `RunContextInterceptor` (`APP_INTERCEPTOR`) |
| Injection guard | `block` | `InjectionGuard` (`APP_GUARD`) |
| Telemetry spans | on | `TelemetryInterceptor` (`APP_INTERCEPTOR`) |
| Error mapping | on | `OttrixExceptionFilter` |
| CORS | on | `OPTIONS` handler on `OttrixController` |
| Health check | on | `@Get('health')` via `checkHealth(registry)` |
| Graceful shutdown | on | `OttrixLifecycleService` flushes telemetry on destroy |
| DI integration | on | `@InjectAgent()`, `@InjectProvider()`, registries |

---

## How to customize

**Disable HTTP wiring in forRoot:**

```typescript
OttrixModule.forRoot({
  providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
  http: {
    runContext: false,
    telemetry: false,
    injection: false,
  },
});
```

**Explicit controller** (compose guards/interceptors yourself):

```typescript
@Controller('chat')
@UseInterceptors(RunContextInterceptor, TelemetryInterceptor)
@UseGuards(InjectionGuard)
@UseFilters(OttrixExceptionFilter)
class ChatController {
  constructor(@InjectAgent('default') private agent: Agent) {}

  @Post()
  async run(@Body() body: unknown) {
    const extracted = extractMessage(body);
    if (!extracted.ok) throw new HttpException({ error: extracted.error }, extracted.status);
    return this.agent.run(extracted.message);
  }

  @Sse('stream')
  stream(@Query('message') message: string) {
    return createSseStream(this.agent)(message);
  }
}
```

**Injection guard options:**

```typescript
{ provide: OTTRIX_INJECTION_GUARD_OPTIONS, useValue: { mode: 'flag', bodyField: 'prompt' } }
```

**Terminus health:**

```typescript
import { OttrixHealthIndicator } from '@ottrix/nestjs';

@Injectable()
class HealthService {
  constructor(private ottrix: OttrixHealthIndicator) {}
  check() { return this.ottrix.check('ottrix'); }
}
```

See [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md) for request/response/SSE/error formats.

---

## API reference

| Export | Description |
|--------|-------------|
| `OttrixModule` | `forRoot`, `forRootAsync`, `forFeature` |
| `OttrixController` | Zero-config POST / stream / health / OPTIONS |
| `OttrixExceptionFilter` | Global exception filter — `mapOttrixError` |
| `InjectionGuard` | Prompt injection guard (uses `extractMessage` + core guardrail) |
| `RunContextInterceptor` | `buildRunContext` + `runWith` per request |
| `TelemetryInterceptor` | HTTP telemetry spans (streaming-safe) |
| `createSseStream(agent)(message)` | `Agent.stream()` → NestJS SSE `Observable` |
| `OttrixHealthIndicator` | `checkHealth()` wrapped for `@nestjs/terminus` |
| `OttrixLifecycleService` | Config validation + telemetry flush on shutdown |
| `InjectAgent(name)` | Inject a named agent from `forFeature` |
| `InjectProvider(name)` | Inject a registered LLM provider |
| `InjectToolRegistry()` | Inject Ottrix `ToolRegistry` |
| `InjectTelemetry()` | Inject global telemetry instance |
| `agentToken(name)` / `providerToken(name)` | DI tokens |
| `OTTRIX_*` tokens | Module options, registries, guard/interceptor config |
| `resolveHttpOptions` / `createHttpProviders` | Internal HTTP provider wiring |
| `mapOttrixError(error)` | Re-export from `ottrix/http` |
| `OttrixModuleOptions` / `OttrixFeatureOptions` | Configuration types |

Subpath for contract/parity test harnesses: `@ottrix/nestjs/testing` → `createContractHarness()`.

---

## Links

- [BACKEND_ADAPTERS.md](../../BACKEND_ADAPTERS.md)
- [Integration docs](./docs/README.md)
- [Full guide](./docs/guide.md)
- [ottrix core](../core/README.md)
- [@ottrix/express](../express/README.md) · [@ottrix/fastify](../fastify/README.md) · [@ottrix/hono](../hono/README.md)

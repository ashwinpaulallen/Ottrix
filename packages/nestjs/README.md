# @ottrix/nestjs

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Thin **NestJS adapter** for [Ottrix](https://github.com/ashwinpaulallen/ottrix) — dependency injection, lifecycle hooks, HTTP interceptors, guards, SSE streaming, and health checks. All AI logic lives in the `ottrix` core package.

**Version:** 0.1.0 · **Requires:** `ottrix` ≥2.0.0 · **Node:** ≥20 · **License:** MIT

Documentation: [docs/README.md](./docs/README.md) · Full guide: [docs/guide.md](./docs/guide.md)

---

## Install

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

**Optional peers:** `@nestjs/terminus` (health checks)

---

## Quick start

One module import wires providers, telemetry, RunContext, and HTTP spans:

```typescript
import { Controller, Module, Post, Body, Injectable } from '@nestjs/common';
import { OttrixModule, InjectAgent } from '@ottrix/nestjs';
import type { Agent } from 'ottrix';

@Module({
  imports: [
    OttrixModule.forRoot({
      providers: {
        anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
      },
      telemetry: { exporter: 'console' },
      // http defaults: runContext + telemetry interceptors (see below)
    }),
    OttrixModule.forFeature({
      agents: [{ name: 'assistant', systemPrompt: 'You are helpful.' }],
    }),
  ],
  controllers: [ChatController],
})
export class AppModule {}

@Injectable()
class ChatService {
  constructor(@InjectAgent('assistant') private readonly agent: Agent) {}

  ask(message: string) {
    return this.agent.run(message);
  }
}

@Controller('chat')
class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  chat(@Body('message') message: string) {
    return this.chat.ask(message);
  }
}
```

No manual `APP_INTERCEPTOR` wiring required — `forRoot` registers RunContext and telemetry globally by default.

---

## `OttrixModule`

| Method | Purpose |
|--------|---------|
| `forRoot(options)` | Global providers, telemetry, registries, HTTP wiring |
| `forRootAsync(options)` | Async config via factory / `useClass` / `useExisting` |
| `forFeature({ agents })` | Register named agents via core `createAgent()` |

### Providers

```typescript
OttrixModule.forRoot({
  providers: {
    chain: ['anthropic', 'openai'],     // fallback order
    anthropic: { apiKey, model? },
    openai: { apiKey, baseUrl?, model? },
    ollama: { baseUrl?, model? },
  },
});
```

Agents registered in `forFeature` use the module's `ProviderRegistry` by default (including fallback chains).

### Telemetry

Uses the same exporter types as Ottrix core, plus an `otel` shorthand:

```typescript
telemetry: {
  exporter: 'console' | 'langfuse' | 'webhook' | 'braintrust' | 'memory' | 'none' | 'otel',
  enabled?: boolean,                  // default true
  langfuse?: { publicKey, secretKey, baseUrl? },
  braintrust?: { apiKey, projectName, baseUrl?, projectId? },
  webhook?: { url, headers? },
  otel?: { endpoint, protocol?, headers?, serviceName? },
  maxFinishedSpans?: number,
  maxMetricPoints?: number,
}
```

Spans flush on module destroy via `OttrixLifecycleService`.

### HTTP wiring (`http`)

| Value | Behavior |
|-------|----------|
| *(omitted)* | RunContext + telemetry interceptors **on**; injection guard **off** |
| `true` | All three enabled with defaults |
| `false` | No automatic HTTP wiring |
| `{ runContext?, telemetry?, injectionGuard? }` | Fine-grained control |

```typescript
OttrixModule.forRoot({
  providers: { anthropic: { apiKey: '...' } },
  http: {
    runContext: true,
    telemetry: true,
    injectionGuard: { mode: 'block', bodyField: 'message' },
  },
});
```

**RunContextInterceptor** — calls `runWith()` per request; `runId` from `x-request-id` header.

**TelemetryInterceptor** — HTTP span via `getTelemetry()`; RunContext attributes included automatically.

**InjectionGuard** — calls `PromptInjectionGuardrail.checkInput()` on the request body field.

To wire interceptors manually instead, pass `http: false` and register `APP_INTERCEPTOR` / `APP_GUARD` yourself.

### Async configuration

```typescript
OttrixModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: {
      anthropic: { apiKey: config.get('ANTHROPIC_API_KEY')! },
    },
    telemetry: { exporter: 'console' },
  }),
  http: true,  // set here — not inside useFactory
});
```

### Feature agents

Each agent definition is a core `CreateAgentConfig` plus a required `name`:

```typescript
import { createTool } from 'ottrix';
import { z } from 'zod';

OttrixModule.forFeature({
  agents: [
    {
      name: 'researcher',
      systemPrompt: 'You research topics thoroughly.',
      provider: 'anthropic',       // optional — defaults to full registry
      model: 'claude-sonnet-4-20250514',
      tools: [searchTool],         // pass BaseTool[] directly
      guardrails: true,            // core defaults, or CreateGuardrailsConfig
      memory: true,
      maxSteps: 10,
    },
  ],
});
```

Pass tools in the agent config (`tools: [...]`). The global `@InjectToolRegistry()` token is for app-level tool registration outside `forFeature`.

---

## Decorators

| Decorator | Injects |
|-----------|---------|
| `@InjectAgent('name')` | Agent from `forFeature` |
| `@InjectProvider('anthropic')` | Named LLM provider |
| `@InjectProvider()` | Full `ProviderRegistry` |
| `@InjectToolRegistry()` | Global `ToolRegistry` |
| `@InjectTelemetry()` | Ottrix `Telemetry` singleton |

Manual tokens: `agentToken('name')`, `providerToken('anthropic')`, `OTTRIX_PROVIDER_REGISTRY`, `OTTRIX_TOOL_REGISTRY`, `OTTRIX_TELEMETRY`.

---

## SSE streaming

```typescript
import { Controller, Sse, Query, Req } from '@nestjs/common';
import { InjectAgent, createSseStream } from '@ottrix/nestjs';
import type { Agent } from 'ottrix';

@Controller('stream')
export class StreamController {
  constructor(@InjectAgent('assistant') private readonly agent: Agent) {}

  @Sse()
  stream(@Query('message') message: string, @Req() req: Request) {
    return createSseStream(this.agent, message, { signal: req.signal });
  }
}
```

`createSseStream` maps `agent.stream()` to NestJS `Observable<MessageEvent>` with keepalive and disconnect handling.

---

## Health checks

With `@nestjs/terminus`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { OttrixHealthIndicator } from '@ottrix/nestjs';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private ottrix: OttrixHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.ottrix.isHealthy('ottrix')]);
  }
}
```

Pings configured providers and reports circuit breaker state.

---

## Exported API

| Category | Exports |
|----------|---------|
| Module | `OttrixModule` |
| Lifecycle | `OttrixLifecycleService` |
| HTTP setup | `createHttpProviders`, `resolveHttpOptions` |
| Guards | `InjectionGuard` |
| Interceptors | `RunContextInterceptor`, `TelemetryInterceptor` |
| SSE | `createSseStream`, `SseMessageEvent`, `CreateSseStreamOptions` |
| Health | `OttrixHealthIndicator`, `OttrixHealthCheckError` |
| Decorators | `InjectAgent`, `InjectProvider`, `InjectToolRegistry`, `InjectTelemetry` |
| Types | `OttrixModuleOptions`, `OttrixHttpOptions`, `OttrixTelemetryConfig`, `AgentDefinition`, … |

---

## Links

- [Ottrix core](../core/README.md)
- [Integration guide](./docs/guide.md)
- [Core configuration](../core/docs/configuration.md) · [Guardrails](../core/docs/guardrails.md)

[MIT](https://github.com/ashwinpaulallen/ottrix/blob/main/LICENSE)

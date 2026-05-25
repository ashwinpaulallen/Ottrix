# @ottrix/nestjs

First-party **NestJS** integration for [Ottrix](https://github.com/ashwinpaulallen/ottrix) — dependency injection, lifecycle hooks, guards, interceptors, SSE streaming, and health checks.

**Version:** 0.1.0 · **Requires:** `ottrix` ≥2.0.0 · **Node:** ≥20 · **License:** MIT

Detailed module guide: [docs/nestjs.md](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/nestjs.md)

---

## Install

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

**Optional peers:**

- `@nestjs/terminus` — register `OttrixHealthIndicator` in health checks
- `@nestjs/bull` — queue-based agent jobs (bring your own wiring)

---

## Quick start

```typescript
import { Module } from '@nestjs/common';
import { OttrixModule } from '@ottrix/nestjs';

@Module({
  imports: [
    OttrixModule.forRoot({
      providers: {
        chain: ['anthropic', 'openai'],
        anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
        openai: { apiKey: process.env.OPENAI_API_KEY! },
      },
      telemetry: {
        exporter: 'otel',
        otel: { endpoint: 'http://localhost:4318', serviceName: 'my-api' },
      },
    }),
    OttrixModule.forFeature({
      agents: [{ name: 'researcher', systemPrompt: 'You are a researcher.' }],
    }),
  ],
})
export class AppModule {}
```

---

## `OttrixModule`

| Method | Purpose |
|--------|---------|
| `forRoot(options)` | Global providers, telemetry, guardrails, registries |
| `forRootAsync(options)` | Async config via factory, `useClass`, or `useExisting` |
| `forFeature(options)` | Feature-scoped agents, tools, and DAG workflows |

### `forRoot` options

```typescript
OttrixModule.forRoot({
  providers: {
    chain: ['anthropic', 'openai'],           // fallback order
    anthropic: { apiKey, baseUrl?, model? },
    openai: { apiKey, baseUrl?, model? },
    ollama: { baseUrl?, model? },
  },
  telemetry: {
    exporter: 'otel' | 'langfuse' | 'console' | 'webhook',
    otel: { endpoint, headers?, serviceName? },
    langfuse: { publicKey, secretKey, baseUrl? },
    webhook: { url, headers? },
  },
  guardrails: {
    injection: { mode: 'block' | 'flag' | 'sanitize', strictness: 'low' | 'medium' | 'high' },
    pii: { mode: 'block' | 'flag' | 'tokenize' },
    budget: { maxTokens?, maxCostUsd?, maxSteps? },
  },
  runContext: true,  // AsyncLocalStorage RunContext (default: true)
});
```

### Async configuration

```typescript
import { ConfigModule, ConfigService } from '@nestjs/config';

OttrixModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: {
      anthropic: { apiKey: config.get('ANTHROPIC_API_KEY')! },
    },
    telemetry: { exporter: 'console' },
  }),
});
```

### Feature modules

Register agents, tools, and workflows scoped to a module:

```typescript
import { createTool } from 'ottrix';
import { z } from 'zod';
import { OttrixModule } from '@ottrix/nestjs';

OttrixModule.forFeature({
  tools: [
    {
      tool: createTool({
        name: 'search',
        description: 'Search the web',
        input: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ results: [] }),
      }),
    },
  ],
  agents: [
    {
      name: 'researcher',
      systemPrompt: 'You research topics.',
      provider: 'anthropic',
      tools: ['search'],
      maxSteps: 10,
    },
  ],
  workflows: [
    { name: 'pipeline', config: dagWorkflowConfig },
  ],
});
```

Each `forFeature()` call uses an isolated registration token so multiple feature modules can register tools without DI collisions.

---

## Inject agents and services

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { InjectAgent, RunContextService } from '@ottrix/nestjs';
import type { Agent } from 'ottrix/agent';

@Controller('chat')
export class ChatController {
  constructor(
    @InjectAgent('researcher') private readonly agent: Agent,
    private readonly runContext: RunContextService,
  ) {}

  @Post()
  async chat(@Body('message') message: string) {
    const { response } = await this.agent.run(message);
    return { response };
  }
}
```

| Decorator | Injects |
|-----------|---------|
| `@InjectAgent('name')` | Agent from `forFeature` |
| `@InjectWorkflow('name')` | `DAGWorkflow` from `forFeature` |
| `@InjectProvider('anthropic')` | Named LLM provider |
| `@InjectToolRegistry()` | Global `ToolRegistry` |
| `@InjectTelemetry()` | `TelemetryService` |

**Manual tokens:** `agentToken('name')`, `workflowToken('name')`, `providerToken('anthropic')`, `OTTRIX_TOOL_REGISTRY`, `OTTRIX_TELEMETRY`, `OTTRIX_RUN_CONTEXT`, `OTTRIX_GUARDRAIL_SERVICE`.

---

## Guards and interceptors

Register globally (recommended) or per-controller:

```typescript
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  InjectionGuard,
  BudgetGuard,
  TelemetryInterceptor,
  RunContextInterceptor,
} from '@ottrix/nestjs';

@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RunContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor },
    { provide: APP_GUARD, useClass: InjectionGuard },
    { provide: APP_GUARD, useClass: BudgetGuard },
  ],
})
export class AppModule {}
```

| Component | Behavior |
|-----------|----------|
| `RunContextInterceptor` | Sets ALS from `x-run-id`, `x-request-id`, `x-org-id`, and `user.orgId` |
| `TelemetryInterceptor` | Wraps HTTP requests in Ottrix telemetry spans |
| `InjectionGuard` | Scans request body for prompt injection; sanitizes `messages[].content` arrays |
| `BudgetGuard` | Pre-checks org-scope budget when `user.orgId` is present |

`RunContextService.contextFromRequest(req)` builds a `RunContext` from headers and authenticated user metadata.

---

## SSE streaming

Bridge `Agent.stream()` to NestJS `@Sse()` endpoints:

```typescript
import { Controller, Sse, Query, Req } from '@nestjs/common';
import { InjectAgent, createSseHandler } from '@ottrix/nestjs';
import type { Agent } from 'ottrix/agent';
import type { Request } from 'express';

@Controller('stream')
export class StreamController {
  constructor(@InjectAgent('researcher') private readonly agent: Agent) {}

  @Sse()
  stream(@Query('message') message: string, @Req() req: Request) {
    return createSseHandler(this.agent, { signal: req.signal })(message);
  }
}
```

`createSseHandler(agent, { keepaliveMs?, signal? })` returns an RxJS `Observable` compatible with NestJS SSE.

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
    return this.health.check([() => this.ottrix.isHealthy('anthropic')]);
  }
}
```

---

## Telemetry backends

| Backend | `telemetry` config |
|---------|-------------------|
| Jaeger / Grafana Tempo | `{ exporter: 'otel', otel: { endpoint: 'http://localhost:4318' } }` |
| Datadog OTLP | `{ exporter: 'otel', otel: { endpoint: 'https://otlp.datadoghq.com', headers: { 'DD-API-KEY': key } } }` |
| Langfuse | `{ exporter: 'langfuse', langfuse: { publicKey, secretKey } }` |
| Honeycomb | `{ exporter: 'otel', otel: { endpoint: 'https://api.honeycomb.io', headers: { 'x-honeycomb-team': key } } }` |
| Webhook | `{ exporter: 'webhook', webhook: { url: 'https://...' } }` |

`TelemetryService` configures exporters on module init and flushes spans on destroy.

---

## Exported API

| Category | Exports |
|----------|---------|
| Module | `OttrixModule` |
| Services | `ProviderRegistryService`, `ToolRegistryService`, `TelemetryService`, `RunContextService`, `GuardrailService` |
| Guards | `InjectionGuard`, `BudgetGuard` |
| Interceptors | `RunContextInterceptor`, `TelemetryInterceptor` |
| SSE | `createSseHandler`, `SseMessageEvent`, `SseHandlerOptions` |
| Health | `OttrixHealthIndicator`, `OttrixHealthCheckError` |
| Decorators | `InjectAgent`, `InjectWorkflow`, `InjectProvider`, `InjectToolRegistry`, `InjectTelemetry` |
| Types | `OttrixModuleOptions`, `OttrixFeatureOptions`, `AgentDefinition`, `ToolDefinition`, `WorkflowDefinition` |

---

## Links

- [Ottrix core package](../core/README.md)
- [NestJS module docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/nestjs.md)
- [Changelog](https://github.com/ashwinpaulallen/ottrix/blob/main/CHANGELOG.md)

[MIT](https://github.com/ashwinpaulallen/ottrix/blob/main/LICENSE) © [ashwinpaulallen](https://github.com/ashwinpaulallen)

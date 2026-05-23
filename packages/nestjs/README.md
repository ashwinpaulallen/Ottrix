# @ottrix/nestjs

First-party NestJS integration for [Ottrix](https://github.com/ashwinpaulallen/ottrix) — dependency injection, lifecycle hooks, guards, interceptors, SSE streaming, and health checks.

## Install

```bash
npm install @ottrix/nestjs ottrix @nestjs/common @nestjs/core rxjs
```

Requires **`ottrix` ≥2.0.0** as a peer dependency.

Optional peers:

- `@nestjs/terminus` — health check registration
- `@nestjs/bull` — queue-based agent jobs

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
        otel: { endpoint: 'http://localhost:4318' },
      },
    }),
    OttrixModule.forFeature({
      agents: [{ name: 'researcher', systemPrompt: 'You are a researcher.' }],
    }),
  ],
})
export class AppModule {}
```

## Wiring to observability backends

| Backend | `telemetry` config |
|---------|-------------------|
| Jaeger / Grafana Tempo | `{ exporter: 'otel', otel: { endpoint: 'http://localhost:4318' } }` |
| Langfuse | `{ exporter: 'langfuse', langfuse: { publicKey, secretKey } }` |
| Datadog OTLP | `{ exporter: 'otel', otel: { endpoint: 'https://otlp.datadoghq.com', headers: { 'DD-API-KEY': key } } }` |
| Honeycomb | `{ exporter: 'otel', otel: { endpoint: 'https://api.honeycomb.io', headers: { 'x-honeycomb-team': key } } }` |
| Webhook | `{ exporter: 'webhook', webhook: { url: 'https://...' } }` |

## Async configuration

```typescript
OttrixModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: {
      anthropic: { apiKey: config.get('ANTHROPIC_API_KEY')! },
    },
  }),
});
```

## License

MIT

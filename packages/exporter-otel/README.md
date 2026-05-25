# @ottrix/exporter-otel

> **Status:** Not published as a standalone package. OpenTelemetry export ships in **`ottrix`**.

Use the built-in OTLP/HTTP exporter from the core package — no separate install required.

---

## Install

```bash
npm install ottrix
```

---

## Usage

```ts
import { getTelemetry } from 'ottrix';
import { OtelExporter, createOtelExporter } from 'ottrix/exporters/otel';

// Preset backends: 'jaeger' | 'tempo' | 'datadog' | 'honeycomb' | 'custom'
getTelemetry().addExporter(
  createOtelExporter('jaeger', { serviceName: 'my-agent' }),
);

// Or configure manually
getTelemetry().addExporter(new OtelExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent',
  headers: { Authorization: 'Bearer ...' },
}));
```

### Backend presets

| Backend | Factory call |
|---------|--------------|
| Jaeger / local collector | `createOtelExporter('jaeger', { serviceName })` |
| Grafana Tempo | `createOtelExporter('tempo', { endpoint, serviceName })` |
| Datadog OTLP | `createOtelExporter('datadog', { apiKey, serviceName })` |
| Honeycomb | `createOtelExporter('honeycomb', { apiKey, serviceName })` |

### With NestJS

```ts
OttrixModule.forRoot({
  telemetry: {
    exporter: 'otel',
    otel: {
      endpoint: 'http://localhost:4318',
      serviceName: 'my-api',
    },
  },
});
```

See [`@ottrix/nestjs`](../nestjs/README.md).

---

## Features (in `ottrix`)

| Feature | Description |
|---------|-------------|
| OTLP/HTTP JSON | Native exporter — no OpenTelemetry SDK dependency |
| GenAI semantic conventions | Span attributes for LLM calls, tools, and workflows |
| RunContext grouping | Resource attributes from ALS at export time |
| Batching and retry | Configurable batch size with exponential backoff |

---

## Links

- [Observability docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/observability.md#otelexporter)
- [ottrix core package](../core/README.md)

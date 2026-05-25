# @ottrix/exporter-otel

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Standalone OTLP/HTTP trace exporter for Ottrix — send spans to **Jaeger**, **Grafana Tempo**, **Datadog**, **Honeycomb**, or any OTLP-compatible collector.

**Peer dependency:** `ottrix` ≥2.0.0 · **Zero runtime dependencies** (uses native `fetch`)

---

## Install

```bash
npm install @ottrix/exporter-otel ottrix
```

---

## Usage

```ts
import { getTelemetry } from 'ottrix';
import { OtelExporter, createOtelExporter } from '@ottrix/exporter-otel';

getTelemetry().addExporter(
  new OtelExporter({
    endpoint: 'http://localhost:4318',
    serviceName: 'my-agent',
    headers: { Authorization: 'Bearer token' },
  }),
);

// Or use a backend preset:
getTelemetry().addExporter(createOtelExporter('jaeger', { serviceName: 'my-agent' }));
```

Spans are batched (default 50) and flushed every 5s to `{endpoint}/v1/traces` as OTLP/HTTP JSON, with GenAI semantic conventions and ottrix-specific attributes (`ottrix.run.id`, `ottrix.cost.usd`, etc.).

---

## Also available in core

Core no longer ships `ottrix/exporters/otel` — see [MIGRATION.md](../../MIGRATION.md).

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | `getTelemetry()`, GenAI span attributes |
| **`@ottrix/exporter-langfuse`** | Langfuse export |
| **`@ottrix/nestjs`** | Auto-wires OTel when configured in `OttrixModule.forRoot` |

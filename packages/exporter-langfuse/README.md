# @ottrix/exporter-langfuse

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Standalone Langfuse trace exporter for Ottrix — batch ingestion via the Langfuse public API.

**Peer dependency:** `ottrix` ≥2.0.0 · **Zero runtime dependencies**

---

## Install

```bash
npm install @ottrix/exporter-langfuse ottrix
```

---

## Usage

```ts
import { getTelemetry } from 'ottrix';
import { LangfuseExporter } from '@ottrix/exporter-langfuse';

getTelemetry().addExporter(
  new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    baseUrl: 'https://cloud.langfuse.com',
    flushInterval: 5000,
  }),
);
```

Traces are translated to Langfuse ingestion events:

- Root trace → `trace-create` with input/output
- LLM spans → `generation-create` (model, tokens, TTFT, cost metadata)
- Tool/other spans → `span-create`

POST `{baseUrl}/api/public/ingestion` with Basic auth (`publicKey:secretKey`).

---

## Also available in core config

For `telemetry.exporter: 'langfuse'`, install this package and register `LangfuseExporter` manually — core no longer bundles the Langfuse exporter. See [MIGRATION.md](../../MIGRATION.md).

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | `getTelemetry()`, trace types, agent instrumentation |
| **`@ottrix/exporter-otel`** | OpenTelemetry OTLP export |
| **`@ottrix/exporter-braintrust`** | Braintrust project logs |

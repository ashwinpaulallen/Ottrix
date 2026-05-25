# @ottrix/exporter-braintrust

> Part of **[Ottrix](https://github.com/ashwinpaulallen/ottrix)** — TypeScript framework for production LLM agents.  
> **Core:** [`ottrix`](https://www.npmjs.com/package/ottrix) · **All packages:** [docs/README.md](../../docs/README.md)

Export ottrix traces to [Braintrust](https://www.braintrust.dev/) project logs.

## Install

```bash
npm install @ottrix/exporter-braintrust ottrix
```

## Usage

```typescript
import { getTelemetry } from 'ottrix';
import { BraintrustExporter } from '@ottrix/exporter-braintrust';

getTelemetry().setExporter(
  new BraintrustExporter({
    apiKey: process.env.BRAINTRUST_API_KEY!,
    projectName: 'my-agent',
  }),
);
```

Or via config (`telemetry.exporter: 'braintrust'`) after wiring the exporter manually — see [MIGRATION.md](../../MIGRATION.md).

## Related packages

| Package | Role |
|---------|------|
| **`ottrix`** | `getTelemetry()`, trace types |
| **`@ottrix/exporter-langfuse`** | Langfuse ingestion |
| **`@ottrix/exporter-otel`** | OTLP/HTTP export |

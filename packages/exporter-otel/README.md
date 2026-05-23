# @ottrix/exporter-otel

> **Status:** Not published as a standalone package. OpenTelemetry export ships in **`ottrix`**.

## Use the built-in exporter

```bash
npm install ottrix
```

```ts
import { OtelExporter, createOtelExporter } from 'ottrix/exporters/otel';

getTelemetry().addExporter(createOtelExporter('datadog', {
  apiKey: process.env.DD_API_KEY!,
  serviceName: 'my-agent',
}));
```

See [docs/observability.md](../../docs/observability.md#otelexporter).

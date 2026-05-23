# @ottrix/exporter-langfuse

> **Status:** Not published as a standalone package. Langfuse export ships in **`ottrix`**.

## Use the built-in exporter

```bash
npm install ottrix
```

```ts
import { LangfuseExporter } from 'ottrix/exporters/langfuse';

getTelemetry().setExporter(new LangfuseExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
}));
```

See [docs/observability.md](../../docs/observability.md).

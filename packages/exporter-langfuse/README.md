# @ottrix/exporter-langfuse

> **Status:** Not published as a standalone package. Langfuse export ships in **`ottrix`**.

Use the built-in Langfuse trace exporter from the core package.

---

## Install

```bash
npm install ottrix
```

Set credentials:

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
```

---

## Usage

```ts
import { getTelemetry, LangfuseExporter } from 'ottrix';
// or: import { LangfuseExporter } from 'ottrix/exporters/langfuse';

getTelemetry().setExporter(
  new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    baseUrl: 'https://cloud.langfuse.com', // optional
  }),
);
```

### Via configuration file

`.ottrixrc.json`:

```json
{
  "telemetry": {
    "enabled": true,
    "exporter": "langfuse",
    "langfuse": {
      "publicKey": "${LANGFUSE_PUBLIC_KEY}",
      "secretKey": "${LANGFUSE_SECRET_KEY}"
    }
  }
}
```

```ts
import { loadConfig, createAgent } from 'ottrix';

const { config } = loadConfig();
const agent = createAgent({ provider: 'anthropic' });
// Telemetry exporter is applied from config when enabled
```

### With NestJS

```ts
OttrixModule.forRoot({
  telemetry: {
    exporter: 'langfuse',
    langfuse: {
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
      secretKey: process.env.LANGFUSE_SECRET_KEY!,
    },
  },
});
```

---

## Features (in `ottrix`)

| Feature | Description |
|---------|-------------|
| Trace export | Agent runs, tool calls, and workflow steps as Langfuse traces |
| Multi-exporter | Combine with OTEL via `getTelemetry().addExporter()` |
| Env-based config | `OTTRIX_TELEMETRY_EXPORTER=langfuse` + `LANGFUSE_*` keys |

Other trace exporters in **`ottrix`:** Braintrust (`ottrix/exporters/braintrust`), webhook (`ottrix/exporters/webhook`), OpenTelemetry (`ottrix/exporters/otel`).

---

## Links

- [Observability docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/observability.md)
- [Configuration docs](https://github.com/ashwinpaulallen/ottrix/blob/main/docs/configuration.md)
- [ottrix core package](../core/README.md)

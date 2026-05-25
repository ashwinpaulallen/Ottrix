# Observability

Source: `src/observability/`

## Global singletons

**File:** `src/observability/global.ts`

| Function | Behavior |
|----------|----------|
| `getTelemetry()` | Lazy `new Telemetry()` if unset |
| `setTelemetry(t)` | Replace global instance |
| `getLogger()` | Lazy `new Logger({ component: 'ottrix' })` |
| `setLogger(l)` | Replace global instance |
| `shutdownObservability()` | Flush trace exporters and reset globals (used by CLI shutdown) |

---

## Logger

**File:** `src/observability/logger.ts`

### Log levels

`debug` · `info` · `warn` · `error` (numeric order 10–40)

Global default: **`info`** via `getGlobalLogLevel` / `setGlobalLogLevel`.

### `LogEntry`

`timestamp`, `level`, `component`, `message`; optional `data`, `context`.

### `LoggerOptions` defaults

| Option | Default |
|--------|---------|
| `component` | `'app'` |
| `level` | global log level |
| `silent` | `false` |
| `pretty` | `true` |
| `jsonLines` | `false` |
| `handler` | `defaultLogHandler` |

### Methods

`debug`, `info`, `warn`, `error(message, data?)` — skip if below instance level or `silent`.

`child(context)` — new logger with merged context object.

**Note:** Logger intentionally uses `console` as its output sink.

---

## Telemetry

**File:** `src/observability/telemetry.ts`

Uses `AsyncLocalStorage` for active span stack (supports nested async agent runs).

### `Telemetry` class

| Method | Behavior |
|--------|----------|
| `startSpan(name, attrs?)` | Child of active span if any; else new `traceId` |
| `withActiveSpan(span, fn)` | Push span, run `fn`, pop in `finally` |
| `setExporter(exporter)` | Replace trace exporter; auto-exports root span on end |
| `addExporter(exporter)` | Append to multi-export list |
| `counter` / `histogram` / `gauge` | Metrics with deduplicated keys |
| `reset()` | Clear spans, metrics, stack |

### Retention (`TelemetryRetentionOptions`)

When configured (via constructor or `applyTelemetryRetention`):

| Option | Behavior |
|--------|----------|
| `maxFinishedSpans` | Drop oldest finished spans |
| `maxMetricPoints` | Drop oldest metric points |
| `maxHistogramSamples` | Per-series cap (default 1000 when retention set) |
| `maxMetricsCollectorSamples` | MetricsCollector series cap |

Config file keys: `telemetry.maxFinishedSpans`, `maxMetricPoints`, etc. (see [Configuration](./configuration.md)).

### Trace export on span end

When a root span ends, `buildTraceData` assembles `TraceData` (spans, input/output, attributes) and calls `TraceExporter.export()`. Exporter errors are logged, not thrown.

---

## Trace exporters

**Files:** `src/observability/exporters/*`

### `TraceExporter` interface

`export(trace: TraceData): Promise<void>`, optional `shutdown()`.

### Implementations

| Class | Destination |
|-------|-------------|
| `LangfuseExporter` | `@ottrix/exporter-langfuse` |
| `BraintrustExporter` | `@ottrix/exporter-braintrust` |
| **`OtelExporter`** | `@ottrix/exporter-otel` |
| `WebhookExporter` | HTTP POST with JSON payload (core) |
| `TraceConsoleExporter` | `console.info` formatted trace (core) |
| `InMemoryTraceExporter` | In-memory array (tests, core) |
| `MultiExporter` | Fan-out to multiple exporters (core) |

### `@ottrix/exporter-otel`

Install: `npm install @ottrix/exporter-otel ottrix`

Translates Ottrix spans to OTLP/HTTP JSON with GenAI and Ottrix semantic conventions. No protobuf/grpc dependency.

```ts
import { OtelExporter, createOtelExporter } from '@ottrix/exporter-otel';
import { getTelemetry } from 'ottrix';

// Local collector (Jaeger, Grafana Tempo)
getTelemetry().addExporter(new OtelExporter({
  endpoint: 'http://localhost:4318',
  serviceName: 'my-agent',
}));

// Factory presets
const datadog = createOtelExporter('datadog', {
  apiKey: process.env.DD_API_KEY!,
  serviceName: 'my-agent',
});
```

| Option | Default |
|--------|---------|
| `protocol` | `'http'` (`grpc` throws — use HTTP JSON) |
| `batchSize` | `50` |
| `flushIntervalMs` | `5000` |
| `maxRetries` | `3` |
| `fetchTimeoutMs` | `30000` |

**Behavior:**

- Captures `RunContext` at export time and groups spans into separate OTLP resources per run
- Retries 5xx and 429; drops permanent 4xx batches (no infinite re-queue)
- `shutdown()` drains buffer with explicit drop on persistent failure
- Optional Langfuse cross-link via `setLangfuseTraceId()`

**Semantic attributes:** `gen_ai.*`, `ottrix.agent.name`, `ottrix.run.id`, `ottrix.tool.name`, `ottrix.cost.usd`, `ottrix.ttft_ms`

### Configuration wiring

```ts
import { configureTraceExportFromConfig, loadConfig } from 'ottrix';

const { config } = loadConfig();
configureTraceExportFromConfig(config.telemetry);
```

Or manually:

```ts
import { getTelemetry } from 'ottrix';
import { LangfuseExporter } from '@ottrix/exporter-langfuse';

getTelemetry().setExporter(new LangfuseExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
}));
```

### Subpath imports

```ts
import { LangfuseExporter } from '@ottrix/exporter-langfuse';
import { BraintrustExporter } from '@ottrix/exporter-braintrust';
import { WebhookExporter } from 'ottrix/exporters/webhook';
import { OtelExporter } from '@ottrix/exporter-otel';
```

**Helpers:** `buildTraceData`, `createTraceExporterFromConfig`, `configureTraceExportFromConfig`

### Legacy in-process exporters

| Class | Behavior |
|-------|----------|
| `ConsoleExporter` | Span/metric `console.info` (telemetry `addExporter`) |
| `InMemoryExporter` | Appends spans/metrics internally |

---

## Metrics bridge

**File:** `src/observability/metrics.ts`

`MetricsCollector` integrates with `Telemetry` for unified counter/histogram recording. Instrumented providers record `llm.calls`, `llm.tokens`, `llm.latency_ms`, stream variants, and TTFT histograms.

---

## Instrumentation

**File:** `src/observability/instrument.ts`

| Function | Behavior |
|----------|----------|
| `isInstrumentedProvider(p)` | Checks instrumented symbol |
| `instrumentProvider(provider, telemetry, options?)` | Wraps `complete` and `stream` |
| `instrumentAgentToolRegistry(registry, telemetry, options?)` | Tool execution spans |
| `runToolSpan(telemetry, component, toolName, fn)` | Span `tool.execute` |

### Instrumented `complete`

Span `llm.complete` — records tokens, latency, TTFT (`llm.ttft_ms`), error counters.

### Instrumented `stream`

Span `llm.stream` with active span context for nested tool spans during streaming.

---

## RunRecorder

**File:** `src/observability/replay.ts`

Records agent runs for debugging and replay. See prior API: `startRun`, `recordMessage`, `endRun`, `replay`, etc.

---

## Subpath exports

### `ottrix/observability`

Logger, Telemetry, RunRecorder, trace exporters, instrumentation, global getters/setters, retention helpers.

### Root `ottrix`

Commonly used symbols including `WebhookExporter`, `MultiExporter`, `configureTraceExportFromConfig`. Langfuse, Braintrust, and OTel exporters live in `@ottrix/exporter-*` packages.

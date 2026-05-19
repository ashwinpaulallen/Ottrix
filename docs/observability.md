# Observability

Source: `src/observability/`

## Global singletons

**File:** `src/observability/global.ts`

| Function | Behavior |
|----------|----------|
| `getTelemetry()` | Lazy `new Telemetry()` if unset |
| `setTelemetry(t)` | Replace global instance |
| `getLogger()` | Lazy `new Logger({ component: 'agentic-fabric' })` |
| `setLogger(l)` | Replace global instance |

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

### Default handler

- `jsonLines: true` → `console.log(JSON.stringify(entry))`
- `pretty: true` → formatted line; `error` → `console.error`, `warn` → `console.warn`
- Else → JSON via `console.log`

`safeJsonStringify` returns `'[Unserializable]'` on failure.

**Note:** Logger intentionally uses `console` as its output sink.

---

## Telemetry

**File:** `src/observability/telemetry.ts`

### `Telemetry` class

| Method | Behavior |
|--------|----------|
| `startSpan(name, attrs?)` | Child of active span if any; else new `traceId` (`randomUUID`) |
| `withActiveSpan(span, fn)` | Push span, run `fn`, pop in `finally` |
| `enterActiveSpan` / `leaveActiveSpan` | Manual stack management |
| `getFinishedSpansSince(index)` | `spans.slice(index)` |
| `counter(name, attrs?)` | Deduped cumulative counter |
| `histogram(name, attrs?)` | Records values |
| `gauge(name, attrs?)` | Sets current value |
| `addExporter(exporter)` | Append exporter |
| `reset()` | Clear spans, metrics, stack, instruments |

Metric deduplication key: `name` + sorted JSON of attributes.

Exporter errors during `exportSpan` / `exportMetric` are **swallowed** (try/catch).

### `Span` class

- `setAttribute`, `addEvent`, `setStatus(code, message?)`
- `end()` — sets duration; status `unset` → `ok`; records span to telemetry; histogram `span.duration_ms`

### Exporters (implemented)

| Class | Behavior |
|-------|----------|
| `ConsoleExporter` | `console.info` for spans and metrics |
| `InMemoryExporter` | Appends to internal arrays; `clear()` |

`OpenTelemetryBridge` is an **interface only** in this module (no OTEL adapter shipped).

---

## Instrumentation

**File:** `src/observability/instrument.ts`

| Function | Behavior |
|----------|----------|
| `isInstrumentedProvider(p)` | Checks `Symbol.for('agentic-fabric.observability.instrumented')` |
| `instrumentProvider(provider, telemetry, options?)` | Wraps `complete` and `stream`; `countTokens` passthrough |
| `instrumentAgentToolRegistry(registry, telemetry, options?)` | Clones `ToolRegistry` with telemetry or wraps generic registry |
| `runToolSpan(telemetry, component, toolName, fn)` | Span `tool.execute` around tool fn |

### Instrumented `complete`

Span `llm.complete` with attrs `component`, `llm.model`. On success: token attrs, `llm.calls` counter, `llm.tokens` histogram, `llm.latency_ms`. On error: `llm.errors` counter.

### Instrumented `stream`

Span `llm.stream`; `enterActiveSpan` for iteration; on `done` chunk with usage, records tokens; `llm.stream_calls` and latency histogram.

Default `component`: `'provider'` or `'tools'`.

---

## RunRecorder

**File:** `src/observability/replay.ts`

### Types

- **`RecordedRun`:** `id`, `agentName`, `input`, `response`, `stopReason?`, timestamps, `steps`, `messages`, `spans`, optional `result`
- **`RecordedRunStep`:** timeline entry with `type: 'input'|'llm'|'tool'|'output'|'span'`

### Methods

| Method | Behavior |
|--------|----------|
| `startRun(input, agentName?)` | **Error** if run already active |
| `recordMessage` / `recordAgentStep` / `recordSpan` | No-op if no active run |
| `endRun(result)` | **Error** if no active run; pushes completed run |
| `cancelRun()` | Clears active run without saving |
| `getRuns()` / `getLatestRun()` | Access completed runs |
| `toJSON(pretty?)` | Serialize all runs |
| `fromJSON(json)` static | **Error** if not JSON array |
| `replay(runId?)` | Generator over sorted timeline (input → spans → steps → output) |
| `clear()` | Empty all runs |

### Agent integration

`Agent` calls `startRun` at run start, records messages/steps/spans when configured, `endRun` on success, `cancelRun` on thrown error.

---

## Subpath `agentic-fabric/observability`

Full barrel: Logger, Telemetry, RunRecorder, exporters, instrumentation helpers, global getters/setters.

Root export includes commonly used symbols; use subpath for `runToolSpan`, `isInstrumentedProvider`, etc.

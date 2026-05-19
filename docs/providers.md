# Providers

Source: `src/providers/`

All built-in providers implement `CompletionProvider` via `BaseProvider` and use **native `fetch`** (no vendor SDK packages).

## `ProviderError`

**File:** `src/providers/errors.ts`

| Field | Type |
|-------|------|
| `code` | `rate_limit` \| `auth` \| `context_length` \| `server_error` \| `timeout` \| `unknown` |
| `retryable` | `boolean` |
| `originalError` | `unknown` |
| `message` | `string` |

`ProviderError.isProviderError(error)` — type guard.

---

## `BaseProvider`

**File:** `src/providers/base.ts`  
**Extend for custom HTTP APIs.**

### Config defaults (`BaseProviderConfig`)

| Field | Default |
|-------|---------|
| `maxRetries` | `3` |
| `retryInitialDelayMs` | `500` |
| `retryMaxDelayMs` | `30_000` |
| `requestsPerMinute` | `60` (token bucket) |
| `timeout` | `60_000` ms |

Also inherits `ProviderConfig`: `defaultModel` (required), optional `apiKey`, `baseUrl`, `maxRetries`, `timeout`, `onRequest`, `onResponse` hooks.

### Public methods

| Method | Retry behavior |
|--------|----------------|
| `complete(params)` | Retries on `retryable` errors with exponential backoff |
| `stream(params)` | Retries only **before first chunk** on connection errors (`timeout`, `server_error`) |
| `countTokens(messages)` | Rate-limited; **not** retried |

### HTTP status mapping (base)

| Status | Code | Retryable |
|--------|------|-----------|
| 401, 403 | `auth` | No |
| 429 | `rate_limit` | Yes |
| 408 | `timeout` | Yes |
| 413, 422 | `context_length` | No |
| ≥ 500 | `server_error` | Yes |
| Other | `unknown` | No |

### Protected methods (subclasses implement)

- `_rawComplete(params): Promise<CompletionResult>`
- `_rawStream(params): AsyncGenerator<StreamChunk>`
- `_countTokens(messages): Promise<number>`

Helpers: `makeRequest`, `fetchStreamResponse`, `errorFromHttpResponse`, `normalizeError`, `resolveModel`.

---

## Anthropic provider

**File:** `src/providers/anthropic.ts`  
**Factory:** `createAnthropicProvider({ apiKey, model?, ... })`

| Constant | Value |
|----------|-------|
| `ANTHROPIC_MESSAGES_URL` | `https://api.anthropic.com/v1/messages` |
| `ANTHROPIC_COUNT_TOKENS_URL` | `https://api.anthropic.com/v1/messages/count_tokens` |
| `ANTHROPIC_API_VERSION` | `2023-06-01` |
| `ANTHROPIC_DEFAULT_MODEL` | `claude-sonnet-4-20250514` |

- **apiKey** required — missing → `ProviderError` (`auth`, not retryable)
- Headers: `x-api-key`, `anthropic-version`, `content-type`
- Default `max_tokens` in request body: **4096**
- Maps `role: tool` → user message with `tool_result` blocks
- Stream: SSE with `text_delta`, `tool_use_start`, `tool_use_delta`, `tool_use_end`, `done`

Vendor-specific HTTP: 529 → `server_error` (retryable); 429 → `rate_limit`; 401 → `auth`.

---

## OpenAI provider

**File:** `src/providers/openai.ts`  
**Factory:** `createOpenAIProvider({ apiKey, model?, baseUrl?, organization?, ... })`

| Constant | Value |
|----------|-------|
| `OPENAI_DEFAULT_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_DEFAULT_MODEL` | `gpt-4o` |

- **apiKey** required — `ProviderError` (`auth`)
- `baseUrl` trailing slash stripped; `chatCompletionsUrl` = `{baseUrl}/chat/completions` unless base already ends with `/chat/completions`
- Optional `OpenAI-Organization` header
- Tools as `{ type: 'function', function: { name, description, parameters } }`
- Stream: parses `data:` SSE lines; skips `[DONE]`; closes tool calls on `finish_reason === 'tool_calls'`
- `_countTokens`: POST with `max_tokens: 1`; requires `usage` in response

Vendor HTTP: 401 → `auth`; 429 → `rate_limit`; 413 → `context_length`.

---

## Ollama provider

**File:** `src/providers/ollama.ts`  
**Factory:** `createOllamaProvider(config?)` — all fields optional

| Constant | Value |
|----------|-------|
| `OLLAMA_DEFAULT_BASE_URL` | `http://localhost:11434` |
| `OLLAMA_DEFAULT_MODEL` | `llama3.1` |

- No API key
- Constructor sets `maxRetries` to **2** (overrides base default 3)
- `enableTools` default **true**; if tools unsupported, retries once without tools
- `listModels(baseUrl?)` — GET `/api/tags`
- `healthCheck()` — GET base URL; never throws
- Chat: POST `/api/chat` (NDJSON stream)
- Tool stream: emits `tool_use_start` + `tool_use_end` immediately (no deltas); IDs `ollama_{name}_{index}`
- `normalizeError`: `econnrefused` → `server_error` (retryable)

---

## Stream chunk types (all providers)

| Type | `data` shape |
|------|----------------|
| `text_delta` | `{ text: string }` |
| `tool_use_start` | `{ id, name }` |
| `tool_use_delta` | `{ id, partialInput }` (Anthropic, OpenAI only) |
| `tool_use_end` | `{ id, name, input }` |
| `done` | `{ stopReason, usage? }` |

---

## `ProviderRegistry`

**File:** `src/providers/registry.ts`  
**Implements:** `CompletionProvider`

### Registration

`register(name, provider, options?)` — stores provider and cost rates.

**Cost tiers (USD per 1k tokens, default tier `medium`):**

| Tier | Input | Output |
|------|-------|--------|
| free | 0 | 0 |
| low | 0.00015 | 0.0006 |
| medium | 0.003 | 0.015 |
| high | 0.01 | 0.03 |

### Methods

| Method | Behavior |
|--------|----------|
| `get(name)` | Throws `ProviderError` if not registered |
| `setDefault(name)`, `setFallbackChain(chain)` | Validates names exist |
| `setHealthy(name, healthy)` | Manual health override |
| `isHealthy(name)` | Considers consecutive failure threshold |
| `selectProvider(criteria?)` | Filters healthy + criteria; sorts by cost, then latency, then name |
| `complete` / `stream` / `countTokens` | Tries fallback chain; `shouldTryFallback` on failure |
| `getCostSummary()`, `resetCostTracking()` | Usage accounting |

| Option | Default |
|--------|---------|
| `unhealthyFailureThreshold` | `3` consecutive failures |

### `shouldTryFallback(error)`

`true` only for `ProviderError` where `retryable` and code is **not** `auth` or `context_length`.

### `estimateCost(usage, rates)`

Linear: `(inputTokens/1000)*inputPer1k + (outputTokens/1000)*outputPer1k`.

---

## Subpath exports

`agentic-fabric/providers` — full barrel  
`agentic-fabric/providers/anthropic` · `/openai` · `/ollama` · `/base` · `/registry` · `/errors` — individual modules

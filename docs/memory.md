# Memory

Source: `src/memory/`

## `WorkingMemory`

**File:** `src/memory/working.ts`  
**Purpose:** In-session message buffer with token budgeting and optional LLM summarization.

### Options (`WorkingMemoryOptions`)

| Option | Default |
|--------|---------|
| `maxTokens` | `128_000` |
| `reservedResponseTokens` | `4_096` |
| `keepRecentMessages` | `4` |
| `reservedSystemTokens` | Estimated from `systemPrompt` if set, else `0` |
| `tokenEstimator` | `createTokenEstimator()` |
| `summarizationProvider` | None |

### Methods

| Method | Behavior |
|--------|----------|
| `addMessage(message)` | Append clone; then `enforceBudgetSlidingWindow()` |
| `getMessages()` | Shallow copy of history |
| `getTokenCount()` | Via `tokenEstimator.estimateMessages` |
| `summarize(provider?)` | Requires provider arg or `summarizationProvider`; runs LLM condensation |
| `clear()` | Empty history |
| `snapshot()` | `{ version: 1, messages, createdAt: Date.now() }` |
| `restore(snapshot)` | **Error** if `version !== 1` |
| `findMessages(query)` | Case-insensitive keyword match; empty query → `[]` |
| `getAvailableTokenBudget()` | `max(0, maxTokens - reservedSystem - reservedResponse)` |

### Budget enforcement

**Sliding window** (`enforceBudgetSlidingWindow`): While over budget, drops oldest of: middle conversation, oldest summary system message, or oldest recent (if more than one recent). Preserves primary system messages and messages with `metadata.workingMemorySummary === true`.

**Summarization** (`condenseWithSummarization`): If middle section longer than `keepRecent`, calls `provider.complete` with fixed system prompt (`maxTokens: 1024`, `temperature: 0`), replaces middle with one summary system message tagged `[Conversation summary]` and `workingMemorySummary: true`.

**Error:** `WorkingMemory.summarize requires a CompletionProvider...` when no provider available.

---

## `SemanticMemory`

**File:** `src/memory/semantic.ts`  
**Implements:** `MemoryProvider<SemanticMemoryMetadata>`

### Requirements

- `embeddings: EmbeddingProvider`
- `vectorStore: VectorStore`

### Options (`SemanticMemoryOptions` extends chunking)

| Option | Default |
|--------|---------|
| `maxChunkSize` | `800` |
| `chunkOverlap` | `100` |

### Methods

| Method | Behavior |
|--------|----------|
| `ingest(documents)` | Chunk per document, embed batch, upsert ids `{documentId}::chunk_{index}`; replaces prior chunks for same document |
| `store(entry)` | Single entry embed + upsert |
| `retrieve(query, options?)` | Embed query; search with filter `{ ...options.filter, memoryType: 'semantic' }` |
| `deleteDocument(documentId)` | Remove tracked chunks |
| `clear()` | Delete all chunk ids |

Metadata includes `memoryType: 'semantic'`, `documentId`, `chunkIndex`, `timestamp`.

---

## `EpisodicMemory`

**File:** `src/memory/episodic.ts`  
**Implements:** `MemoryProvider<EpisodicMemoryMetadata>`

Same embedding + vector store requirements as semantic.

### Static helpers

- `formatInteraction(input)` — formats Task, Tools used, Outcome lines
- `createEntry(id, input, extraMetadata?)` — formatted content + `memoryType: 'episodic'`

### Methods

| Method | Behavior |
|--------|----------|
| `store(entry)` | Embed if needed; upsert with episodic metadata |
| `retrieve(query, options?)` | Filter `memoryType: 'episodic'` |
| `clear()` | Delete all entry ids |

No per-id delete API.

---

## Vector store

**File:** `src/memory/vector-store.ts`

### `VectorStore` interface

`upsert(entries)`, `search(queryVector, options?)`, `delete(ids)`

### `InMemoryVectorStore` (only implementation in package)

| Search default | Value |
|----------------|-------|
| `limit` | `10` |
| `threshold` | `0` (no minimum score filter) |

- First upsert sets `expectedDimensions`; rejects empty vectors or dimension mismatch
- Search: cosine similarity; rejects empty query vector or mismatch
- Test helpers: `size()`, `get(id)`, `clear()`

### `cosineSimilarity(a, b)`

Throws on dimension mismatch; returns `0` if zero magnitude; result clamped to `[0, 1]`.

---

## Embeddings

**File:** `src/memory/embeddings.ts`

### `EmbeddingProvider`

`embed(text)`, `embedBatch(texts)`

### `FetchEmbeddingProvider`

| Default | Value |
|---------|-------|
| `baseUrl` | `https://api.openai.com/v1` |
| `model` | `text-embedding-3-small` |
| `fetchImpl` | `fetch` |

`POST {baseUrl}/embeddings` with optional `dimensions` and Bearer token if `apiKey` set.

**Errors:** invalid JSON, HTTP error message, missing/short `data` array, count mismatch, missing embedding at index.

### `NoOpEmbeddingProvider`

| Default | Value |
|---------|-------|
| `dimensions` | `8` |

Returns zero vectors (similarity search yields score 0 for all).

---

## Chunking and tokens

**`chunkText(content, options?)`** (`chunking.ts`): splits on paragraph boundaries, respects `maxChunkSize` and `chunkOverlap` (capped to `maxChunkSize - 1`).

**`createTokenEstimator(options?)`** (`tokens.ts`): `tokensPerWord` default **1.3**; minimum 1 token per text.

**Utils** (`utils.ts`): `assertValidVector`, `assertBatchEmbeddings` throw on empty/mismatched embeddings; `messageToText` / `contentToText` for memory text extraction.

---

## Exports (`agentic-fabric/memory`)

`WorkingMemory`, `SemanticMemory`, `EpisodicMemory`, `InMemoryVectorStore`, `NoOpEmbeddingProvider`, `FetchEmbeddingProvider`, type `MemorySnapshot`.

`SemanticMemory` also re-exports `chunkText`.

---

## Agent integration

When `Agent` has `memory` configured, `prepareRun` calls `memory.retrieve(input, { limit: 5 })` and injects results into context.  
`createAgent({ memory: true })` uses internal keyword-based `KeywordMemoryProvider` (not exported).

/**
 * A single unit of persisted agent memory.
 *
 * @typeParam TMeta - Shape of application-specific metadata.
 */
export interface MemoryEntry<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique storage key. */
  id: string;
  /** Searchable text content. */
  content: string;
  /** Arbitrary filters and labels. */
  metadata?: TMeta;
  /** Optional embedding vector for semantic retrieval. */
  embedding?: number[];
  /** Unix epoch milliseconds when the entry was stored. */
  timestamp: number;
}

/**
 * Options for similarity or keyword retrieval.
 */
export interface RetrievalOptions<TFilter extends Record<string, unknown> = Record<string, unknown>> {
  /** Maximum number of entries to return. */
  limit?: number;
  /** Minimum similarity score in `[0, 1]` when using vector search. */
  threshold?: number;
  /** Metadata key-value filters applied before ranking. */
  filter?: TFilter;
}

/**
 * Pluggable long-term or session memory backend.
 *
 * @typeParam TMeta - Metadata type stored on each {@link MemoryEntry}.
 * @typeParam TFilter - Filter object type for {@link RetrievalOptions}.
 */
export interface MemoryProvider<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TFilter extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Persist a memory entry. */
  store(entry: MemoryEntry<TMeta>): Promise<void>;

  /** Retrieve entries relevant to a natural-language query. */
  retrieve(query: string, options?: RetrievalOptions<TFilter>): Promise<MemoryEntry<TMeta>[]>;

  /** Remove all stored entries. */
  clear(): Promise<void>;
}

/** Stored vector with searchable text and metadata. */
export interface VectorEntry {
  /** Unique entry identifier. */
  id: string;
  /** Embedding vector. */
  vector: number[];
  /** Human-readable content that was embedded. */
  content: string;
  /** Arbitrary metadata for filtering and display. */
  metadata: Record<string, unknown>;
}

/** A {@link VectorEntry} returned from similarity search with its score. */
export interface VectorSearchResult extends VectorEntry {
  /** Cosine similarity score in `[0, 1]` (higher is more similar). */
  score: number;
}

/** Options for {@link VectorStore.search}. */
export interface SearchOptions {
  /** Maximum results to return. @defaultValue 10 */
  limit?: number;
  /** Minimum cosine similarity in `[0, 1]`. */
  threshold?: number;
  /** Metadata fields that must match exactly (shallow equality). */
  filter?: Record<string, unknown>;
}

/**
 * Vector database surface area.
 *
 * Implement this interface to connect external backends (Qdrant, pgvector, Pinecone, Chroma, etc.).
 */
export interface VectorStore {
  /** Insert or replace entries by id. */
  upsert(entries: VectorEntry[]): Promise<void>;
  /** Find nearest neighbors by cosine similarity. */
  search(vector: number[], options?: SearchOptions): Promise<VectorSearchResult[]>;
  /** Remove entries by id. */
  delete(ids: string[]): Promise<void>;
}

/**
 * Alias for {@link VectorStore} emphasizing external adapter implementations.
 */
export type VectorStoreAdapter = VectorStore;

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns `0` when either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, score));
}

/**
 * In-memory {@link VectorStore} using cosine similarity.
 *
 * Suitable for development, tests, and small datasets.
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, VectorEntry>();
  private expectedDimensions?: number;

  /** @inheritdoc */
  upsert(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      if (entry.vector.length === 0) {
        return Promise.reject(
          new Error(`InMemoryVectorStore: entry "${entry.id}" has an empty vector`),
        );
      }

      if (this.expectedDimensions === undefined) {
        this.expectedDimensions = entry.vector.length;
      } else if (entry.vector.length !== this.expectedDimensions) {
        return Promise.reject(
          new Error(
            `InMemoryVectorStore: dimension mismatch for "${entry.id}" ` +
              `(expected ${this.expectedDimensions}, got ${entry.vector.length})`,
          ),
        );
      }

      this.entries.set(entry.id, {
        id: entry.id,
        vector: [...entry.vector],
        content: entry.content,
        metadata: { ...entry.metadata },
      });
    }
    return Promise.resolve();
  }

  /** @inheritdoc */
  search(vector: number[], options: SearchOptions = {}): Promise<VectorSearchResult[]> {
    if (vector.length === 0) {
      return Promise.reject(new Error('InMemoryVectorStore: query vector must not be empty'));
    }

    if (
      this.expectedDimensions !== undefined &&
      vector.length !== this.expectedDimensions
    ) {
      return Promise.reject(
        new Error(
          `InMemoryVectorStore: query dimension mismatch ` +
            `(expected ${this.expectedDimensions}, got ${vector.length})`,
        ),
      );
    }

    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0;
    const filter = options.filter;

    const scored: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (filter && !matchesFilter(entry.metadata, filter)) {
        continue;
      }

      const score = cosineSimilarity(vector, entry.vector);
      if (score >= threshold) {
        scored.push({
          id: entry.id,
          vector: [...entry.vector],
          content: entry.content,
          metadata: { ...entry.metadata },
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return Promise.resolve(scored.slice(0, limit));
  }

  /** @inheritdoc */
  delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.entries.delete(id);
    }
    return Promise.resolve();
  }

  /** Number of stored entries (for tests). */
  size(): number {
    return this.entries.size;
  }

  /** Return a stored entry by id (for tests). */
  get(id: string): VectorEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    return {
      id: entry.id,
      vector: [...entry.vector],
      content: entry.content,
      metadata: { ...entry.metadata },
    };
  }

  /** Remove all entries (for tests and local resets). */
  clear(): Promise<void> {
    this.entries.clear();
    this.expectedDimensions = undefined;
    return Promise.resolve();
  }
}

function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (metadata[key] !== value) {
      return false;
    }
  }
  return true;
}

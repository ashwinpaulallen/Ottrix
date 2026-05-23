import type { MemoryEntry, MemoryProvider, RetrievalOptions } from '../types/memory.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VectorStore } from './vector-store.js';
import { assertValidVector } from './utils.js';

/** Structured metadata for episodic (interaction) memories. */
export interface EpisodicMemoryMetadata extends Record<string, unknown> {
  /** Original task or user goal. */
  task?: string;
  /** Tool names invoked during the interaction. */
  toolsUsed?: string[];
  /** Outcome description or final response summary. */
  outcome?: string;
  /** Whether the interaction succeeded. */
  success?: boolean;
  /** Unix epoch milliseconds (also on {@link MemoryEntry.timestamp}). */
  timestamp?: number;
  /** Memory layer discriminator. */
  memoryType: 'episodic';
}

/** Input for formatting episodic memory content. */
export interface EpisodicInteractionInput {
  /** Task or user request. */
  task: string;
  /** Tools used during the interaction. */
  toolsUsed?: string[];
  /** Outcome or result summary. */
  outcome: string;
  /** Whether the task succeeded. */
  success?: boolean;
}

/** Options for {@link EpisodicMemory}. */
export interface EpisodicMemoryOptions {
  /** Embedding backend. */
  embeddings: EmbeddingProvider;
  /** Vector storage backend. */
  vectorStore: VectorStore;
}

/**
 * Episodic memory — stores past agent interactions and outcomes for retrieval.
 *
 * Useful for "remember when we…" queries and learning from prior successes or failures.
 */
export class EpisodicMemory implements MemoryProvider<EpisodicMemoryMetadata> {
  private readonly embeddings: EmbeddingProvider;
  private readonly vectorStore: VectorStore;
  private readonly entryIds = new Set<string>();

  /**
   * @param options - Embeddings and vector store.
   */
  constructor(options: EpisodicMemoryOptions) {
    this.embeddings = options.embeddings;
    this.vectorStore = options.vectorStore;
  }

  /**
   * Format interaction fields into searchable text for embedding.
   */
  static formatInteraction(input: EpisodicInteractionInput): string {
    const tools =
      input.toolsUsed && input.toolsUsed.length > 0
        ? input.toolsUsed.join(', ')
        : 'none';
    const status = input.success === false ? 'failed' : 'succeeded';
    return [
      `Task: ${input.task}`,
      `Tools used: ${tools}`,
      `Outcome (${status}): ${input.outcome}`,
    ].join('\n');
  }

  /**
   * Build a {@link MemoryEntry} for episodic storage.
   */
  static createEntry(
    id: string,
    input: EpisodicInteractionInput,
    extraMetadata?: Record<string, unknown>,
  ): MemoryEntry<EpisodicMemoryMetadata> {
    return {
      id,
      content: EpisodicMemory.formatInteraction(input),
      timestamp: Date.now(),
      metadata: {
        memoryType: 'episodic',
        task: input.task,
        toolsUsed: input.toolsUsed,
        outcome: input.outcome,
        success: input.success,
        ...extraMetadata,
      },
    };
  }

  /** @inheritdoc */
  async store(entry: MemoryEntry<EpisodicMemoryMetadata>): Promise<void> {
    const vector = entry.embedding ?? (await this.embeddings.embed(entry.content));
    assertValidVector(vector, 'EpisodicMemory.store');
    const timestamp = entry.timestamp ?? Date.now();

    this.entryIds.add(entry.id);

    await this.vectorStore.upsert([
      {
        id: entry.id,
        vector,
        content: entry.content,
        metadata: {
          ...entry.metadata,
          memoryType: 'episodic',
          timestamp,
        },
      },
    ]);
  }

  /** @inheritdoc */
  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<MemoryEntry<EpisodicMemoryMetadata>[]> {
    const vector = await this.embeddings.embed(query);
    const results = await this.vectorStore.search(vector, {
      limit: options?.limit,
      threshold: options?.threshold,
      filter: { ...options?.filter, memoryType: 'episodic' },
    });

    return results.map((result) => this.toMemoryEntry(result));
  }

  /** @inheritdoc */
  async clear(): Promise<void> {
    const ids = [...this.entryIds];
    this.entryIds.clear();
    if (ids.length > 0) {
      await this.vectorStore.delete(ids);
    }
  }

  private toMemoryEntry(result: {
    id: string;
    content: string;
    vector: number[];
    metadata: Record<string, unknown>;
  }): MemoryEntry<EpisodicMemoryMetadata> {
    const timestamp =
      typeof result.metadata.timestamp === 'number'
        ? result.metadata.timestamp
        : Date.now();

    return {
      id: result.id,
      content: result.content,
      embedding: result.vector,
      timestamp,
      metadata: {
        memoryType: 'episodic',
        task: typeof result.metadata.task === 'string' ? result.metadata.task : undefined,
        toolsUsed: Array.isArray(result.metadata.toolsUsed)
          ? result.metadata.toolsUsed.filter((t): t is string => typeof t === 'string')
          : undefined,
        outcome:
          typeof result.metadata.outcome === 'string' ? result.metadata.outcome : undefined,
        success:
          typeof result.metadata.success === 'boolean' ? result.metadata.success : undefined,
        timestamp,
      },
    };
  }
}

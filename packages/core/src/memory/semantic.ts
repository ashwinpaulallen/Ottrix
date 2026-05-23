import type { MemoryEntry, MemoryProvider, RetrievalOptions } from '../types/memory.js';
import { chunkText, type ChunkingOptions } from './chunking.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VectorStore } from './vector-store.js';
import { assertBatchEmbeddings, assertValidVector } from './utils.js';

/** A document to ingest into semantic memory. */
export interface Document {
  /** Unique document identifier. */
  id: string;
  /** Full document text. */
  content: string;
  /** Optional document-level metadata copied to each chunk. */
  metadata?: Record<string, unknown>;
}

/** Metadata attached to each semantic memory chunk. */
export interface SemanticMemoryMetadata extends Record<string, unknown> {
  /** Source document id. */
  documentId: string;
  /** Chunk index within the document. */
  chunkIndex: number;
  /** Memory layer discriminator. */
  memoryType: 'semantic';
}

/** Options for {@link SemanticMemory}. */
export interface SemanticMemoryOptions extends ChunkingOptions {
  /** Embedding backend. */
  embeddings: EmbeddingProvider;
  /** Vector storage backend. */
  vectorStore: VectorStore;
}

/**
 * Semantic (RAG) memory — chunked knowledge base with vector retrieval.
 */
export class SemanticMemory implements MemoryProvider<SemanticMemoryMetadata> {
  private readonly embeddings: EmbeddingProvider;
  private readonly vectorStore: VectorStore;
  private readonly maxChunkSize: number;
  private readonly chunkOverlap: number;
  private readonly chunkIds = new Set<string>();
  /** Maps document id → chunk ids for replace-on-reingest. */
  private readonly documentChunkIds = new Map<string, string[]>();

  /**
   * @param options - Embeddings, vector store, and chunking settings.
   */
  constructor(options: SemanticMemoryOptions) {
    this.embeddings = options.embeddings;
    this.vectorStore = options.vectorStore;
    this.maxChunkSize = options.maxChunkSize ?? 800;
    this.chunkOverlap = options.chunkOverlap ?? 100;
  }

  /**
   * Chunk, embed, and store documents.
   */
  async ingest(documents: Document[]): Promise<void> {
    const entries: Array<{
      id: string;
      vector: number[];
      content: string;
      metadata: SemanticMemoryMetadata;
    }> = [];

    for (const document of documents) {
      await this.removeDocumentChunks(document.id);

      const chunks = chunkText(document.content, {
        maxChunkSize: this.maxChunkSize,
        chunkOverlap: this.chunkOverlap,
      });

      if (chunks.length === 0) {
        continue;
      }

      const vectors = await this.embeddings.embedBatch(chunks);
      assertBatchEmbeddings(chunks, vectors, 'SemanticMemory.ingest');

      const documentChunks: string[] = [];
      const storedAt = Date.now();

      chunks.forEach((chunk, index) => {
        const id = `${document.id}::chunk_${index}`;
        const vector = vectors[index];
        assertValidVector(vector, `SemanticMemory.ingest chunk ${index}`);

        this.chunkIds.add(id);
        documentChunks.push(id);
        entries.push({
          id,
          vector,
          content: chunk,
          metadata: {
            memoryType: 'semantic',
            documentId: document.id,
            chunkIndex: index,
            timestamp: storedAt,
            ...document.metadata,
          },
        });
      });

      this.documentChunkIds.set(document.id, documentChunks);
    }

    if (entries.length > 0) {
      await this.vectorStore.upsert(entries);
    }
  }

  /** @inheritdoc */
  async store(entry: MemoryEntry<SemanticMemoryMetadata>): Promise<void> {
    const vector = entry.embedding ?? (await this.embeddings.embed(entry.content));
    assertValidVector(vector, 'SemanticMemory.store');
    const timestamp = entry.timestamp ?? Date.now();

    this.chunkIds.add(entry.id);

    await this.vectorStore.upsert([
      {
        id: entry.id,
        vector,
        content: entry.content,
        metadata: {
          memoryType: 'semantic',
          documentId: entry.metadata?.documentId ?? entry.id,
          chunkIndex: entry.metadata?.chunkIndex ?? 0,
          timestamp,
          ...entry.metadata,
        },
      },
    ]);
  }

  /** @inheritdoc */
  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<MemoryEntry<SemanticMemoryMetadata>[]> {
    const vector = await this.embeddings.embed(query);
    const results = await this.vectorStore.search(vector, {
      limit: options?.limit,
      threshold: options?.threshold,
      filter: { ...options?.filter, memoryType: 'semantic' },
    });

    return results.map((result) => this.toMemoryEntry(result));
  }

  /** Remove all chunks for a document id. */
  async deleteDocument(documentId: string): Promise<void> {
    await this.removeDocumentChunks(documentId);
  }

  /** @inheritdoc */
  async clear(): Promise<void> {
    const ids = [...this.chunkIds];
    this.chunkIds.clear();
    this.documentChunkIds.clear();
    if (ids.length > 0) {
      await this.vectorStore.delete(ids);
    }
  }

  private async removeDocumentChunks(documentId: string): Promise<void> {
    const existing = this.documentChunkIds.get(documentId);
    if (!existing || existing.length === 0) {
      return;
    }

    await this.vectorStore.delete(existing);
    for (const id of existing) {
      this.chunkIds.delete(id);
    }
    this.documentChunkIds.delete(documentId);
  }

  private toMemoryEntry(result: {
    id: string;
    content: string;
    vector: number[];
    metadata: Record<string, unknown>;
  }): MemoryEntry<SemanticMemoryMetadata> {
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
        memoryType: 'semantic',
        documentId:
          typeof result.metadata.documentId === 'string'
            ? result.metadata.documentId
            : (String(result.id).split('::')[0] ?? result.id),
        chunkIndex:
          typeof result.metadata.chunkIndex === 'number' ? result.metadata.chunkIndex : 0,
        timestamp,
        ...result.metadata,
      },
    };
  }
}

/** Re-export chunking for convenience. */
export { chunkText } from './chunking.js';

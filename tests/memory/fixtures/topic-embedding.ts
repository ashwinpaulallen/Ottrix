import type { EmbeddingProvider } from '../../../src/memory/embeddings.js';

/** Maps cat/car vocabulary to orthogonal vectors for predictable retrieval tests. */
export class TopicEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    if (/cat|kitten|pet/i.test(text)) {
      return [1, 0, 0, 0];
    }
    if (/car|vehicle|motor|truck/i.test(text)) {
      return [0, 1, 0, 0];
    }
    return [0.5, 0.5, 0, 0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

import type { EmbeddingProvider } from '../../../src/memory/embeddings.js';

/**
 * Deterministic normalized vectors derived from text — for retrieval ranking tests.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;

  constructor(dimensions = 8) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return this.vectorize(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorize(text));
  }

  private vectorize(text: string): number[] {
    const vector: number[] = Array.from({ length: this.dimensions }, () => 0);
    for (let i = 0; i < text.length; i++) {
      const index = i % this.dimensions;
      vector[index] = (vector[index] ?? 0) + text.charCodeAt(i);
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude === 0) {
      return vector;
    }
    return vector.map((value) => value / magnitude);
  }
}

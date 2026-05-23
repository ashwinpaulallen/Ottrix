/** Deep-clone a metadata record. */
export function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return { ...metadata };
}

/** Validate that an embedding vector is non-empty. */
export function assertValidVector(vector: number[], context: string): void {
  if (vector.length === 0) {
    throw new Error(`${context}: embedding vector must not be empty`);
  }
}

/** Ensure batch embeddings align with input texts. */
export function assertBatchEmbeddings(
  texts: string[],
  vectors: number[][],
  context: string,
): void {
  if (vectors.length !== texts.length) {
    throw new Error(
      `${context}: expected ${texts.length} embeddings, received ${vectors.length}`,
    );
  }
  vectors.forEach((vector, index) => {
    if (vector.length === 0) {
      throw new Error(`${context}: empty embedding at index ${index}`);
    }
  });
}

import { createHash } from 'node:crypto';
import type { CompactionStrategy } from './compaction-types.js';

export interface DigestEntry {
  topicIndex?: string;
  digest: string;
  strategy: CompactionStrategy;
  createdAt: number;
  hitCount: number;
}

/**
 * Bounded in-memory cache of compaction digests, keyed by a hash of the
 * folded message prefix. Unchanged prefixes reuse the stored digest.
 */
export class DigestCache {
  private readonly cache = new Map<string, DigestEntry>();
  private readonly _capacity: number;

  constructor(capacity = 50) {
    this._capacity = capacity;
  }

  /**
   * Hash the messages that are about to be folded.
   *
   * Uses role, content length, and the first 100 characters of each message
   * so large tool outputs are not hashed in full. Collisions favor a new
   * summary, which is safe (correctness before efficiency).
   */
  static hashMessages(messages: Array<{ role: string; content: unknown }>): string {
    const input = messages
      .map((message) => {
        const serialized =
          typeof message.content === 'string'
            ? message.content
            : (JSON.stringify(message.content) ?? '');
        const text = serialized.slice(0, 100);
        return `${message.role}:${serialized.length}:${text}`;
      })
      .join('|');

    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  get(hash: string): DigestEntry | undefined {
    const entry = this.cache.get(hash);
    if (entry) {
      entry.hitCount++;
      return entry;
    }
    return undefined;
  }

  set(hash: string, entry: Omit<DigestEntry, 'hitCount' | 'createdAt'>): void {
    if (!this.cache.has(hash) && this.cache.size >= this._capacity) {
      this.evict();
    }
    this.cache.set(hash, { ...entry, hitCount: 0, createdAt: Date.now() });
  }

  /** Remove the entry with the lowest hit count, or the oldest when tied. */
  private evict(): void {
    let minHits = Infinity;
    let oldest = Infinity;
    let evictKey: string | undefined;

    for (const [key, entry] of this.cache) {
      if (entry.hitCount < minHits || (entry.hitCount === minHits && entry.createdAt < oldest)) {
        minHits = entry.hitCount;
        oldest = entry.createdAt;
        evictKey = key;
      }
    }

    if (evictKey) {
      this.cache.delete(evictKey);
    }
  }

  get size(): number {
    return this.cache.size;
  }

  get capacity(): number {
    return this._capacity;
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): { size: number; capacity: number; hitRate?: number } {
    return { size: this.cache.size, capacity: this.capacity };
  }
}

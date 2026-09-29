import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigestCache } from '../../../src/agent/context/digest-cache.js';

const prose = { digest: 'folded prefix', strategy: 'prose' as const };

describe('DigestCache.hashMessages', () => {
  it('returns the same hash for the same messages', () => {
    const messages = [
      { role: 'user', content: 'Plan the trip' },
      { role: 'assistant', content: 'Where to?' },
    ];

    expect(DigestCache.hashMessages(messages)).toBe(DigestCache.hashMessages(messages));
  });

  it('returns a different hash when messages differ', () => {
    const left = [{ role: 'user', content: 'Plan the trip' }];
    const right = [{ role: 'user', content: 'Cancel the trip' }];

    expect(DigestCache.hashMessages(left)).not.toBe(DigestCache.hashMessages(right));
  });

  it('ignores characters after the first 100 when length matches', () => {
    const prefix = 'a'.repeat(100);
    const sameLength = 'b'.repeat(4);
    const left = [{ role: 'tool', content: `${prefix}${sameLength}` }];
    const right = [{ role: 'tool', content: `${prefix}${'c'.repeat(4)}` }];
    const withinWindow = [{ role: 'tool', content: `b${'a'.repeat(99)}${sameLength}` }];

    expect(DigestCache.hashMessages(left)).toBe(DigestCache.hashMessages(right));
    expect(DigestCache.hashMessages(left)).not.toBe(DigestCache.hashMessages(withinWindow));
  });
});

describe('DigestCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves an entry', () => {
    const cache = new DigestCache();
    const hash = DigestCache.hashMessages([{ role: 'user', content: 'hello' }]);

    cache.set(hash, { digest: 'greeting', strategy: 'hierarchical', topicIndex: '- hello' });

    expect(cache.get(hash)).toMatchObject({
      digest: 'greeting',
      strategy: 'hierarchical',
      topicIndex: '- hello',
      hitCount: 1,
    });
  });

  it('returns undefined for a missing key', () => {
    const cache = new DigestCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('increments hitCount on each get', () => {
    const cache = new DigestCache();
    cache.set('h', prose);

    expect(cache.get('h')?.hitCount).toBe(1);
    expect(cache.get('h')?.hitCount).toBe(2);
  });

  it('evicts the entry with the lowest hit count when full', () => {
    const cache = new DigestCache(3);
    cache.set('cold', { digest: 'cold', strategy: 'prose' });
    cache.set('warm', { digest: 'warm', strategy: 'prose' });
    cache.set('hot', { digest: 'hot', strategy: 'prose' });
    cache.get('hot');
    cache.get('warm');
    cache.get('warm');

    cache.set('incoming', { digest: 'incoming', strategy: 'truncate' });

    expect(cache.get('cold')).toBeUndefined();
    expect(cache.get('warm')?.digest).toBe('warm');
    expect(cache.get('hot')?.digest).toBe('hot');
    expect(cache.get('incoming')?.digest).toBe('incoming');
    expect(cache.size).toBe(3);
  });

  it('evicts the oldest entry when hit counts tie', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const cache = new DigestCache(2);
    cache.set('old', { digest: 'old', strategy: 'prose' });
    vi.setSystemTime(2_000);
    cache.set('newer', { digest: 'newer', strategy: 'prose' });
    vi.setSystemTime(3_000);
    cache.set('newest', { digest: 'newest', strategy: 'hierarchical' });

    expect(cache.get('old')).toBeUndefined();
    expect(cache.get('newer')?.digest).toBe('newer');
    expect(cache.get('newest')?.digest).toBe('newest');
  });

  it('clears every entry', () => {
    const cache = new DigestCache();
    cache.set('h', prose);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('h')).toBeUndefined();
  });

  it('never exceeds its capacity', () => {
    const cache = new DigestCache(2);

    for (let index = 0; index < 10; index += 1) {
      cache.set(`k${index}`, { digest: String(index), strategy: 'prose' });
      expect(cache.size).toBeLessThanOrEqual(cache.capacity);
    }

    expect(cache.size).toBe(2);
    expect(cache.capacity).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { stringifyUnknown } from '../../src/utils/stringify.js';

describe('stringifyUnknown', () => {
  it('returns strings and primitives directly', () => {
    expect(stringifyUnknown('hello')).toBe('hello');
    expect(stringifyUnknown(42)).toBe('42');
    expect(stringifyUnknown(true)).toBe('true');
    expect(stringifyUnknown(null)).toBe('');
  });

  it('stringifies plain objects as JSON', () => {
    expect(stringifyUnknown({ a: 1 })).toBe('{"a":1}');
  });

  it('prefers meaningful text fields over generic JSON', () => {
    expect(stringifyUnknown({ response: 'answer', extra: 1 })).toBe('answer');
    expect(stringifyUnknown({ error: 'failed' })).toBe('failed');
  });

  it('unwraps tool result shapes', () => {
    expect(stringifyUnknown({ success: true, output: 'payload' })).toBe('payload');
    expect(stringifyUnknown({ success: false, output: null, error: 'denied' })).toBe('denied');
  });

  it('handles circular references without [object Object]', () => {
    const circular: { self?: unknown; note: string } = { note: 'loop' };
    circular.self = circular;

    const text = stringifyUnknown(circular);
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('loop');
  });

  it('stringifies bigint values in objects', () => {
    expect(stringifyUnknown({ value: 1n })).toBe('{"value":"1"}');
  });
});

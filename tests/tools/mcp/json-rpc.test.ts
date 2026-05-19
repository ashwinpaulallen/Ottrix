import { describe, expect, it } from 'vitest';
import { RequestIdGenerator, buildRequest } from '../../../src/tools/mcp/json-rpc.js';

describe('RequestIdGenerator', () => {
  it('generates monotonically increasing ids per instance', () => {
    const gen = new RequestIdGenerator();
    expect(gen.generate()).toBe(1);
    expect(gen.generate()).toBe(2);
    expect(gen.generate()).toBe(3);
  });

  it('isolates state across instances (no global counter)', () => {
    const a = new RequestIdGenerator();
    const b = new RequestIdGenerator();
    expect(a.generate()).toBe(1);
    expect(b.generate()).toBe(1);
    expect(a.generate()).toBe(2);
    expect(b.generate()).toBe(2);
  });

  it('can be reset', () => {
    const gen = new RequestIdGenerator();
    gen.generate();
    gen.generate();
    gen.reset();
    expect(gen.generate()).toBe(1);
  });
});

describe('buildRequest', () => {
  it('requires an explicit id', () => {
    const req = buildRequest('tools/list', {}, 42);
    expect(req).toEqual({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} });
  });
});

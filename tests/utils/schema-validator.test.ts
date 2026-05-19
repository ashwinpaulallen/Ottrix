import { describe, expect, it } from 'vitest';
import { validateSchema } from '../../src/utils/schema-validator.js';

describe('validateSchema', () => {
  it('validates required object properties', () => {
    const result = validateSchema(
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('name');
  });

  it('validates enum values', () => {
    const result = validateSchema({ enum: ['a', 'b'] }, 'c');
    expect(result.valid).toBe(false);
  });

  it('validates numeric minimum and maximum', () => {
    expect(validateSchema({ type: 'number', minimum: 0, maximum: 10 }, 5).valid).toBe(true);
    expect(validateSchema({ type: 'number', minimum: 0, maximum: 10 }, 11).valid).toBe(false);
  });

  it('validates string pattern', () => {
    expect(validateSchema({ type: 'string', pattern: '^[a-z]+$' }, 'hello').valid).toBe(true);
    expect(validateSchema({ type: 'string', pattern: '^[a-z]+$' }, 'Hello1').valid).toBe(false);
  });

  it('validates array items', () => {
    const result = validateSchema(
      {
        type: 'array',
        items: { type: 'string' },
      },
      [1, 'ok'],
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('[0]'))).toBe(true);
  });

  it('rejects additional properties when disabled', () => {
    const result = validateSchema(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      { a: 'x', extra: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('extra');
  });
});

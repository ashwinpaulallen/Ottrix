import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateSchema } from './schema-validator.js';
import { ZOD_REQUIRED_MESSAGE, zodToJsonSchema } from './zod-to-json-schema.js';

describe('zodToJsonSchema (Zod v4)', () => {
  it('converts primitive Zod types', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('maps string refinements to JSON Schema constraints', () => {
    const schema = z.string().min(3).max(10).length(5).regex(/^[a-z]+$/).email();

    const jsonSchema = zodToJsonSchema(schema);
    expect(jsonSchema.type).toBe('string');
    expect(jsonSchema.minLength).toBe(5);
    expect(jsonSchema.maxLength).toBe(5);
    expect(jsonSchema.format).toBe('email');
    expect(jsonSchema.pattern ?? jsonSchema.allOf?.[0]?.pattern).toBeDefined();
  });

  it('maps number refinements to JSON Schema constraints', () => {
    expect(zodToJsonSchema(z.int().min(0).max(100))).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 100,
    });

    expect(zodToJsonSchema(z.number().min(0).max(100))).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
    });
  });

  it('maps describe() to description', () => {
    expect(zodToJsonSchema(z.string().describe('User email'))).toEqual({
      type: 'string',
      description: 'User email',
    });
  });

  it('maps default() to default', () => {
    expect(zodToJsonSchema(z.string().default('guest'))).toEqual({
      type: 'string',
      default: 'guest',
    });
  });

  it('converts nested objects with optional fields', () => {
    const schema = z.object({
      id: z.string(),
      profile: z.object({
        name: z.string(),
        nickname: z.string().optional(),
      }),
      tags: z.array(z.string()).optional(),
    });

    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        profile: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            nickname: { type: 'string' },
          },
          required: ['name'],
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['id', 'profile'],
    });
  });

  it('converts arrays of objects', () => {
    const schema = z.array(
      z.object({
        sku: z.string(),
        quantity: z.int().min(1),
      }),
    );

    const jsonSchema = zodToJsonSchema(schema);
    expect(jsonSchema.type).toBe('array');
    expect(jsonSchema.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        sku: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
      },
      required: ['sku', 'quantity'],
    });
  });

  it('converts enums and unions', () => {
    expect(zodToJsonSchema(z.enum(['draft', 'published']))).toEqual({
      type: 'string',
      enum: ['draft', 'published'],
    });

    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('converts optional and nullable schemas', () => {
    expect(zodToJsonSchema(z.string().optional())).toEqual({ type: 'string' });
    expect(zodToJsonSchema(z.string().nullable())).toEqual({
      type: ['string', 'null'],
    });
  });

  it('converts literals, records, tuples, intersections, and dates', () => {
    expect(zodToJsonSchema(z.literal('ok'))).toEqual({
      type: 'string',
      enum: ['ok'],
    });

    expect(zodToJsonSchema(z.record(z.string(), z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });

    expect(zodToJsonSchema(z.tuple([z.string(), z.number()]))).toEqual({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
    });

    expect(
      zodToJsonSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))),
    ).toEqual({
      allOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: { a: { type: 'string' } },
          required: ['a'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: { b: { type: 'number' } },
          required: ['b'],
        },
      ],
    });

    expect(zodToJsonSchema(z.date())).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('throws for unsupported Zod types', () => {
    expect(() => zodToJsonSchema(z.lazy(() => z.string()))).toThrow(
      'Unsupported Zod type "lazy". z.lazy, z.promise, and z.function are not supported.',
    );
    expect(() => zodToJsonSchema(z.promise(z.string()))).toThrow(
      'Unsupported Zod type "promise". z.lazy, z.promise, and z.function are not supported.',
    );
    expect(() => zodToJsonSchema(z.function())).toThrow(
      'Unsupported Zod type "function". z.lazy, z.promise, and z.function are not supported.',
    );
  });

  it('produces JSON Schema shapes that validate known good values', () => {
    const toolSchema = zodToJsonSchema(
      z.object({
        query: z.string().min(1).describe('Search query'),
        limit: z.int().min(1).max(50).default(10),
        mode: z.enum(['fast', 'deep']).optional(),
      }),
    );

    expect(
      validateSchema(toolSchema, {
        query: 'agents',
        limit: 25,
        mode: 'fast',
      }).valid,
    ).toBe(true);

    expect(validateSchema(toolSchema, { query: '', limit: 25 }).valid).toBe(false);
    expect(validateSchema(toolSchema, { query: 'agents', limit: 100 }).valid).toBe(false);
    expect(validateSchema(toolSchema, { limit: 5 }).valid).toBe(false);
  });

  it('validates nested object and array payloads against converted schema', () => {
    const schema = zodToJsonSchema(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            enabled: z.boolean().optional(),
          }),
        ),
      }),
    );

    expect(
      validateSchema(schema, {
        items: [{ id: 'a' }, { id: 'b', enabled: true }],
      }).valid,
    ).toBe(true);

    expect(validateSchema(schema, { items: [{ enabled: true }] }).valid).toBe(false);
  });

  it('exposes a helpful message when zod is missing', () => {
    expect(ZOD_REQUIRED_MESSAGE).toBe(
      'Zod is required for schema features. Install it: npm install zod',
    );
  });
});

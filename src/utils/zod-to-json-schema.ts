import { createRequire } from 'node:module';
import type { ZodTypeAny } from 'zod';
import type { JSONSchema, JSONSchemaType } from '../types/tools.js';

/** Error message when the optional `zod` peer dependency is not installed. */
export const ZOD_REQUIRED_MESSAGE =
  'Zod is required for schema features. Install it: npm install zod';

const require = createRequire(import.meta.url);

let zodModule: typeof import('zod') | undefined;
let zodImportPromise: Promise<typeof import('zod')> | undefined;

void import('zod')
  .then((mod) => {
    zodModule = mod;
  })
  .catch(() => {
    /* optional peer */
  });

function loadZod(): typeof import('zod') {
  if (zodModule) {
    return zodModule;
  }

  try {
    zodModule = require('zod') as typeof import('zod');
    return zodModule;
  } catch {
    throw new Error(ZOD_REQUIRED_MESSAGE);
  }
}

/** Async preload for callers that can await the optional `zod` peer. */
export async function ensureZodPeer(): Promise<void> {
  if (zodModule) {
    return;
  }

  if (!zodImportPromise) {
    zodImportPromise = import('zod')
      .then((mod) => {
        zodModule = mod;
        return mod;
      })
      .catch(() => {
        zodImportPromise = undefined;
        throw new Error(ZOD_REQUIRED_MESSAGE);
      });
  }

  await zodImportPromise;
}

const UNSUPPORTED_ZOD_TYPES = new Set(['lazy', 'promise', 'function']);

interface Zod4Def {
  type: string;
  innerType?: ZodTypeAny;
  element?: ZodTypeAny;
  shape?: Record<string, ZodTypeAny>;
  options?: ZodTypeAny[];
  left?: ZodTypeAny;
  right?: ZodTypeAny;
  keyType?: ZodTypeAny;
  valueType?: ZodTypeAny;
  items?: ZodTypeAny[];
  rest?: ZodTypeAny | null;
  in?: ZodTypeAny;
  out?: ZodTypeAny;
  entries?: Record<string, string | number>;
  values?: unknown[];
  defaultValue?: unknown;
}

function getZod4Def(schema: ZodTypeAny): Zod4Def {
  return schema._def as unknown as Zod4Def;
}

function unwrapZodNode(current: ZodTypeAny, next: ZodTypeAny | undefined): ZodTypeAny {
  if (!next || next === current) {
    throw new Error(`Unable to unwrap invalid Zod schema node "${getZod4Def(current).type}".`);
  }
  return next;
}

interface ParsedSchemaMeta {
  schema: ZodTypeAny;
  description?: string;
  defaultValue?: unknown;
  nullable: boolean;
}

/**
 * Convert a Zod v4 schema to the simplified {@link JSONSchema} shape used by tool definitions.
 *
 * Requires the optional peer dependency `zod` (^4).
 */
export function zodToJsonSchema(schema: ZodTypeAny): JSONSchema {
  loadZod();

  if (typeof schema.toJSONSchema !== 'function') {
    throw new Error(
      'zodToJsonSchema requires Zod v4 or newer (schema.toJSONSchema is missing). Install zod@^4.',
    );
  }

  return convertSchema(schema);
}

function convertSchema(schema: ZodTypeAny): JSONSchema {
  const meta = parseSchemaMeta(schema);
  assertSupported(meta.schema);

  let result = convertInnerSchema(meta.schema);

  if (meta.description !== undefined) {
    result = { ...result, description: meta.description };
  }

  if (meta.defaultValue !== undefined) {
    result = { ...result, default: meta.defaultValue };
  }

  if (meta.nullable) {
    result = applyNullable(result);
  }

  return result;
}

function parseSchemaMeta(schema: ZodTypeAny): ParsedSchemaMeta {
  let current = schema;
  let description = current.description;
  let defaultValue: unknown;
  let nullable = false;

  for (;;) {
    assertSupported(current);
    const def = getZod4Def(current);
    const type = def.type;

    switch (type) {
      case 'optional':
        current = unwrapZodNode(current, def.innerType);
        break;
      case 'nullable':
        nullable = true;
        current = unwrapZodNode(current, def.innerType);
        break;
      case 'default': {
        if (defaultValue === undefined) {
          const value = def.defaultValue;
          defaultValue = typeof value === 'function' ? (value as () => unknown)() : value;
        }
        current = unwrapZodNode(current, def.innerType);
        break;
      }
      case 'catch':
      case 'readonly':
        current = unwrapZodNode(current, def.innerType);
        break;
      case 'pipe':
        current = unwrapZodNode(current, def.in);
        break;
      default:
        if (current.description && !description) {
          description = current.description;
        }
        return { schema: current, description, defaultValue, nullable };
    }

    if (current.description && !description) {
      description = current.description;
    }
  }
}

function convertInnerSchema(schema: ZodTypeAny): JSONSchema {
  assertSupported(schema);
  const def = getZod4Def(schema);
  const type = def.type;

  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
    case 'literal':
      return normalizeJsonSchema(schema.toJSONSchema() as Record<string, unknown>);
    case 'date':
      return { type: 'string', format: 'date-time' };
    case 'array':
      return {
        type: 'array',
        items: convertSchema(def.element ?? schema),
      };
    case 'object':
      return convertObjectSchema(schema);
    case 'union':
      return {
        anyOf: (def.options ?? []).map((option) => convertSchema(option)),
      };
    case 'record':
      return {
        type: 'object',
        additionalProperties: convertSchema(def.valueType ?? schema),
      };
    case 'tuple': {
      const items = (def.items ?? []).map((item) => convertSchema(item));
      const rest = def.rest;
      if (rest) {
        return {
          type: 'array',
          items: [...items, convertSchema(rest)],
        };
      }
      return {
        type: 'array',
        items,
      };
    }
    case 'intersection':
      return {
        allOf: [
          convertSchema(def.left ?? schema),
          convertSchema(def.right ?? schema),
        ],
      };
    case 'null':
      return { type: 'null' };
    case 'undefined':
    case 'any':
    case 'unknown':
      return {};
    default:
      throw unsupportedTypeError(type);
  }
}

function convertObjectSchema(schema: ZodTypeAny): JSONSchema {
  const shape = getZod4Def(schema).shape ?? {};
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const [key, propertySchema] of Object.entries(shape)) {
    properties[key] = convertSchema(propertySchema);
    if (!propertySchema.isOptional()) {
      required.push(key);
    }
  }

  const result: JSONSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}

function normalizeJsonSchema(raw: Record<string, unknown>): JSONSchema {
  const result: JSONSchema = {};

  const rawType = raw.type;
  if (typeof rawType === 'string' || Array.isArray(rawType)) {
    result.type = rawType as JSONSchemaType | JSONSchemaType[];
  }

  if (raw.description !== undefined && typeof raw.description === 'string') {
    result.description = raw.description;
  }

  if (raw.default !== undefined) {
    result.default = raw.default;
  }

  if (Array.isArray(raw.enum)) {
    result.enum = [...raw.enum];
  }

  if (raw.const !== undefined && result.enum === undefined) {
    const value = raw.const;
    if (typeof value === 'string') {
      result.type = 'string';
      result.enum = [value];
    } else if (typeof value === 'number') {
      result.type = 'number';
      result.enum = [value];
    } else if (typeof value === 'boolean') {
      result.type = 'boolean';
      result.enum = [value];
    } else {
      result.enum = [value];
    }
  }

  if (typeof raw.minLength === 'number') {
    result.minLength = raw.minLength;
  }
  if (typeof raw.maxLength === 'number') {
    result.maxLength = raw.maxLength;
  }
  if (typeof raw.minimum === 'number') {
    result.minimum = raw.minimum;
  }
  if (typeof raw.maximum === 'number') {
    result.maximum = raw.maximum;
  }
  if (typeof raw.pattern === 'string') {
    result.pattern = raw.pattern;
  }
  if (typeof raw.format === 'string') {
    result.format = raw.format;
  }

  if (Array.isArray(raw.required)) {
    result.required = raw.required.filter((key): key is string => typeof key === 'string');
  }

  if (raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)) {
    result.properties = {};
    for (const [key, value] of Object.entries(raw.properties)) {
      if (value && typeof value === 'object') {
        result.properties[key] = normalizeJsonSchema(value as Record<string, unknown>);
      }
    }
  }

  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties === 'boolean') {
      result.additionalProperties = raw.additionalProperties;
    } else if (typeof raw.additionalProperties === 'object') {
      result.additionalProperties = normalizeJsonSchema(
        raw.additionalProperties as Record<string, unknown>,
      );
    }
  }

  const prefixItems = raw.prefixItems;
  if (Array.isArray(prefixItems)) {
    result.items = prefixItems
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => normalizeJsonSchema(item));
  } else if (raw.items !== undefined) {
    if (Array.isArray(raw.items)) {
      result.items = raw.items
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => normalizeJsonSchema(item));
    } else if (typeof raw.items === 'object' && raw.items !== null) {
      result.items = normalizeJsonSchema(raw.items as Record<string, unknown>);
    }
  }

  if (Array.isArray(raw.anyOf)) {
    result.anyOf = raw.anyOf
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => normalizeJsonSchema(item));
  }

  if (Array.isArray(raw.oneOf)) {
    result.oneOf = raw.oneOf
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => normalizeJsonSchema(item));
  }

  if (Array.isArray(raw.allOf)) {
    result.allOf = raw.allOf
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => normalizeJsonSchema(item));
  }

  return result;
}

function applyNullable(schema: JSONSchema): JSONSchema {
  if (schema.type === 'null') {
    return schema;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? [...schema.type] : [schema.type];
    if (!types.includes('null')) {
      types.push('null');
    }
    return { ...schema, type: types.length === 1 ? types[0] : types };
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(null)) {
      return { ...schema, enum: [...schema.enum, null] };
    }
    return schema;
  }

  return {
    anyOf: [schema, { type: 'null' }],
  };
}

function assertSupported(schema: ZodTypeAny): void {
  const type = getZod4Def(schema).type;
  if (UNSUPPORTED_ZOD_TYPES.has(type)) {
    throw unsupportedTypeError(type);
  }
}

function unsupportedTypeError(type: string): Error {
  return new Error(
    `Unsupported Zod type "${type}". z.lazy, z.promise, and z.function are not supported.`,
  );
}

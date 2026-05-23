import type { JSONSchema, JSONSchemaType } from '../types/tools.js';

/**
 * Result of validating a value against a {@link JSONSchema}.
 */
export interface SchemaValidationResult {
  /** Whether the value satisfies the schema. */
  valid: boolean;
  /** Human-readable validation errors (empty when valid). */
  errors: string[];
}

/**
 * Validate `value` against a simplified JSON Schema.
 *
 * Supports `type`, `required`, `properties`, `enum`, `minimum`, `maximum`,
 * `pattern`, `minLength`, `maxLength`, and `items`.
 *
 * @param schema - Schema to validate against.
 * @param value - Runtime value (typically parsed tool input).
 * @param path - Internal JSON-pointer-style path for error messages.
 */
export function validateSchema(
  schema: JSONSchema,
  value: unknown,
  path = '$',
): SchemaValidationResult {
  const errors: string[] = [];

  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
      errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
      return { valid: false, errors };
    }
    return { valid: true, errors: [] };
  }

  const types = normalizeTypes(schema.type);
  if (types.length > 0 && !matchesAnyType(value, types)) {
    errors.push(`${path}: expected type ${types.join(' | ')}, got ${describeValue(value)}`);
    return { valid: false, errors };
  }

  if (value === null || value === undefined) {
    if (types.includes('null') || schema.default !== undefined) {
      return { valid: true, errors: [] };
    }
    if (types.length === 0) return { valid: true, errors: [] };
    errors.push(`${path}: value is required`);
    return { valid: false, errors };
  }

  if (typeof value === 'string') {
    validateString(schema, value, path, errors);
  } else if (typeof value === 'number') {
    validateNumber(schema, value, path, errors);
  } else if (typeof value === 'boolean') {
    // no extra constraints
  } else if (Array.isArray(value)) {
    validateArray(schema, value, path, errors);
  } else if (typeof value === 'object') {
    validateObject(schema, value as Record<string, unknown>, path, errors);
  }

  return { valid: errors.length === 0, errors };
}

/** Validate an object value against object schema constraints. */
function validateObject(
  schema: JSONSchema,
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of required) {
    if (!(key in value)) {
      errors.push(`${path}: missing required property "${key}"`);
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in value) {
      const child = validateSchema(propSchema, value[key], `${path}.${key}`);
      errors.push(...child.errors);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push(`${path}: additional property "${key}" is not allowed`);
      }
    }
  } else if (typeof schema.additionalProperties === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (!(key in properties)) {
        const child = validateSchema(schema.additionalProperties, val, `${path}.${key}`);
        errors.push(...child.errors);
      }
    }
  }
}

/** Validate an array value against array schema constraints. */
function validateArray(schema: JSONSchema, value: unknown[], path: string, errors: string[]): void {
  const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (!itemSchema) return;

  value.forEach((item, index) => {
    const child = validateSchema(itemSchema, item, `${path}[${index}]`);
    errors.push(...child.errors);
  });
}

/** Validate string constraints. */
function validateString(schema: JSONSchema, value: string, path: string, errors: string[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: string length must be >= ${schema.minLength}`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${path}: string length must be <= ${schema.maxLength}`);
  }
  if (schema.pattern !== undefined) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value)) {
      errors.push(`${path}: must match pattern ${schema.pattern}`);
    }
  }
}

/** Validate number constraints. */
function validateNumber(schema: JSONSchema, value: number, path: string, errors: string[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path}: must be <= ${schema.maximum}`);
  }
}

/** Normalize schema type to an array of allowed types. */
function normalizeTypes(type: JSONSchema['type']): JSONSchemaType[] {
  if (type === undefined) return [];
  return Array.isArray(type) ? type : [type];
}

/** Whether `value` matches any of the allowed JSON Schema types. */
function matchesAnyType(value: unknown, types: JSONSchemaType[]): boolean {
  return types.some((t) => matchesType(value, t));
}

/** Whether `value` matches a single JSON Schema type. */
function matchesType(value: unknown, type: JSONSchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/** Describe a value for error messages. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Deep equality for enum comparison. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && a !== null && b !== null) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    return aKeys.length === bKeys.length && aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
  }
  return false;
}

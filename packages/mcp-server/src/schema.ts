import type { JSONSchema } from 'ottrix';

/** Normalize ottrix tool schemas into MCP-compatible JSON Schema objects. */
export function normalizeMcpInputSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  if (schema.type !== undefined) {
    return schema;
  }
  if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    return { type: 'object', ...schema };
  }
  return schema;
}

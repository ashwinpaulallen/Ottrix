import { inspect } from 'node:util';

const MEANINGFUL_KEYS = [
  'response',
  'text',
  'content',
  'output',
  'error',
  'message',
  'result',
] as const;

/**
 * Convert an unknown value to a stable string for logging, templates, and guardrail scans.
 * Prefers meaningful text fields and JSON; falls back to `util.inspect` for cycles and exotic types.
 */
export function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return value.toString();
  }

  if (typeof value === 'object') {
    const toolText = stringifyToolResultShape(value);
    if (toolText !== undefined) {
      return toolText;
    }

    const meaningful = extractMeaningfulFieldText(value);
    if (meaningful !== undefined) {
      return meaningful;
    }
  }

  try {
    return JSON.stringify(value, jsonReplacer());
  } catch {
    return inspect(value, { depth: 4, breakLength: Infinity, maxArrayLength: 100 });
  }
}

function stringifyToolResultShape(value: object): string | undefined {
  if (!('success' in value) || !('output' in value)) {
    return undefined;
  }

  const record = value as { success?: boolean; output?: unknown; error?: string };
  if (typeof record.error === 'string' && record.error.length > 0) {
    return record.error;
  }
  if (record.output !== undefined) {
    return stringifyUnknown(record.output);
  }
  return undefined;
}

function extractMeaningfulFieldText(value: object): string | undefined {
  for (const key of MEANINGFUL_KEYS) {
    if (!(key in value)) {
      continue;
    }
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === 'string') {
      return field;
    }
    if (field === undefined || field === null) {
      continue;
    }
    if (typeof field === 'number' || typeof field === 'boolean' || typeof field === 'bigint') {
      return String(field);
    }
    if (typeof field === 'symbol' || typeof field === 'function') {
      return field.toString();
    }
    if (typeof field === 'object') {
      const nested = stringifyUnknown(field);
      if (nested.length > 0) {
        return nested;
      }
    }
  }
  return undefined;
}

function jsonReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, val) => {
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (typeof val === 'symbol') {
      return val.toString();
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) {
        return '[Circular]';
      }
      seen.add(val);
    }
    return val;
  };
}

/**
 * Parse workflow files. Tries `js-yaml` via dynamic import when installed,
 * otherwise falls back to a small built-in YAML subset parser.
 */

/** Attempt to load js-yaml as an optional peer dependency. */
export async function tryImportJsYaml(): Promise<{
  load: (content: string) => unknown;
} | null> {
  try {
    const mod = (await import('js-yaml')) as { load: (content: string) => unknown };
    if (typeof mod.load === 'function') {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse file content based on extension. */
export async function parseWorkflowFile(
  content: string,
  filePath: string,
): Promise<unknown> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) {
    return JSON.parse(content) as unknown;
  }

  if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) {
    throw new Error(
      `Unsupported workflow file extension "${filePath}". Use .json, .yaml, or .yml`,
    );
  }

  const yaml = await tryImportJsYaml();
  if (yaml) {
    return yaml.load(content);
  }

  return parseYamlSubset(content);
}

/**
 * Minimal YAML parser for workflow configs (mappings, sequences, scalars).
 * Supports `#` comments and multiline `|` blocks.
 */
export function parseYamlSubset(content: string): unknown {
  const lines = content.split(/\r?\n/);
  const root: YamlNode = { kind: 'map', map: new Map() };
  const stack: Array<{ indent: number; node: YamlNode }> = [{ indent: -1, node: root }];

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index] ?? '';
    index += 1;

    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim() === '') {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;

    if (withoutComment.trimStart().startsWith('- ')) {
      const list = ensureList(parent);
      const itemText = withoutComment.trimStart().slice(2).trim();

      if (itemText.includes(':')) {
        const itemMap: YamlNode = { kind: 'map', map: new Map() };
        parseMappingLine(itemMap, itemText);
        list.items.push(itemMap);
        stack.push({ indent, node: itemMap });
      } else {
        list.items.push(parseScalar(itemText));
      }
      continue;
    }

    if (withoutComment.trimEnd().endsWith('|')) {
      const header = withoutComment.trimEnd().slice(0, -1).trim();
      const colon = header.indexOf(':');
      const key = colon >= 0 ? header.slice(0, colon).trim() : header;
      const blockLines: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (next.trim() === '') {
          blockLines.push('');
          index += 1;
          continue;
        }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) {
          break;
        }
        blockLines.push(next.slice(indent + 2));
        index += 1;
      }
      ensureMap(parent).map.set(key, blockLines.join('\n').trimEnd());
      continue;
    }

    if (withoutComment.includes(':')) {
      const map = ensureMap(parent);
      const trimmed = withoutComment.trim();
      const colon = trimmed.indexOf(':');
      const key = trimmed.slice(0, colon).trim();
      const valuePart = trimmed.slice(colon + 1).trim();

      if (valuePart === '') {
        const next = peekNextContentLine(lines, index);
        if (next && next.content.startsWith('- ') && next.indent > indent) {
          const list: YamlNode = { kind: 'list', items: [] };
          map.map.set(key, list);
          stack.push({ indent, node: list });
        } else {
          const child: YamlNode = { kind: 'map', map: new Map() };
          map.map.set(key, child);
          stack.push({ indent, node: child });
        }
      } else if (valuePart === '{}' || valuePart === 'null') {
        map.map.set(key, null);
      } else {
        map.map.set(key, parseScalar(valuePart));
      }
      continue;
    }
  }

  return yamlNodeToJs(root);
}

function peekNextContentLine(
  lines: string[],
  fromIndex: number,
): { content: string; indent: number } | null {
  for (let i = fromIndex; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') {
      continue;
    }
    return {
      content: withoutComment.trim(),
      indent: raw.length - raw.trimStart().length,
    };
  }
  return null;
}

type YamlNode =
  | { kind: 'map'; map: Map<string, YamlNode | string | number | boolean | null> }
  | { kind: 'list'; items: Array<YamlNode | string | number | boolean | null> };

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function ensureMap(node: YamlNode): { kind: 'map'; map: Map<string, YamlNode | string | number | boolean | null> } {
  if (node.kind === 'map') {
    return node;
  }
  throw new Error('YAML parse error: expected mapping context');
}

function ensureList(node: YamlNode): { kind: 'list'; items: Array<YamlNode | string | number | boolean | null> } {
  if (node.kind === 'list') {
    return node;
  }
  throw new Error('YAML parse error: expected sequence context');
}

function parseMappingLine(
  map: { map: Map<string, YamlNode | string | number | boolean | null> },
  line: string,
): void {
  const colon = line.indexOf(':');
  const key = line.slice(0, colon).trim();
  const valuePart = line.slice(colon + 1).trim();

  if (valuePart === '' || valuePart === '{}' || valuePart === 'null') {
    map.map.set(key, valuePart === '' ? null : null);
    return;
  }

  map.map.set(key, parseScalar(valuePart));
}

function parseScalar(value: string): string | number | boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function yamlNodeToJs(node: YamlNode): unknown {
  if (node.kind === 'list') {
    return node.items.map((item) => {
      if (typeof item === 'object' && item !== null && 'kind' in item) {
        return yamlNodeToJs(item);
      }
      return item;
    });
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of node.map.entries()) {
    if (typeof value === 'object' && value !== null && 'kind' in value) {
      result[key] = yamlNodeToJs(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

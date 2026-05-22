import { FunctionTool } from '../../src/tools/function-tool.js';

/** In-memory file store for the mock file reader tool. */
const fileStore = new Map<string, string>([
  ['readme.txt', 'Welcome to agent-kit.'],
  ['config.json', '{"debug": true}'],
]);

/** Mock weather database keyed by city. */
const weatherData: Record<string, { tempF: number; condition: string }> = {
  'new york': { tempF: 72, condition: 'sunny' },
  london: { tempF: 58, condition: 'cloudy' },
  tokyo: { tempF: 80, condition: 'humid' },
};

/**
 * Evaluate a simple arithmetic expression (digits, +, -, *, /, parentheses).
 * For test fixtures only — not a general-purpose evaluator.
 */
function evaluateExpression(expression: string): number {
  const sanitized = expression.replace(/\s+/g, '');
  if (!/^[0-9+\-*/().]+$/.test(sanitized)) {
    throw new Error('Expression contains invalid characters');
  }

  let index = 0;

  const peek = (): string | undefined => sanitized[index];
  const consume = (): string | undefined => sanitized[index++];

  const parseNumber = (): number => {
    let digits = '';
    while (peek() !== undefined && /[0-9.]/.test(peek()!)) {
      digits += consume();
    }
    if (digits === '') {
      throw new Error('Expected number');
    }
    const value = Number(digits);
    if (!Number.isFinite(value)) {
      throw new Error('Invalid number');
    }
    return value;
  };

  const parseFactor = (): number => {
    if (peek() === '(') {
      consume();
      const value = parseExpression();
      if (consume() !== ')') {
        throw new Error('Expected closing parenthesis');
      }
      return value;
    }
    return parseNumber();
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const right = parseFactor();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };

  const result = parseExpression();
  if (index !== sanitized.length) {
    throw new Error('Unexpected trailing characters');
  }
  return result;
}

function readStringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/** Calculator tool — evaluates simple math expressions. */
export const calculatorTool = new FunctionTool({
  name: 'calculator',
  description: 'Performs basic math operations on a numeric expression',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression e.g. (2 + 3) * 4' },
    },
    required: ['expression'],
  },
  metadata: { cost: 'free', latency: 'fast', idempotent: true },
  execute: async (input) => {
    const expression = readStringField(input, 'expression');
    return { result: evaluateExpression(expression) };
  },
});

/** Mock weather lookup tool with namespaced name. */
export const weatherLookupTool = new FunctionTool({
  name: 'weather.lookup',
  description: 'Returns mock weather for a city',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 1 },
    },
    required: ['city'],
  },
  metadata: { cost: 'low', latency: 'fast' },
  execute: async (input) => {
    const city = readStringField(input, 'city').toLowerCase();
    const record = weatherData[city];
    if (!record) {
      throw new Error(`Unknown city: ${city}`);
    }
    return record;
  },
});

/** Mock file reader tool with namespaced name. */
export const fileReaderTool = new FunctionTool({
  name: 'files.read',
  description: 'Reads a mock file from an in-memory store',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$' },
    },
    required: ['path'],
  },
  metadata: { cost: 'free', latency: 'fast', requiresAuth: false },
  execute: async (input) => {
    const path = readStringField(input, 'path');
    const content = fileStore.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return { path, content };
  },
});

/** All fixture tools for convenient test registration. */
export const fixtureTools = [calculatorTool, weatherLookupTool, fileReaderTool] as const;

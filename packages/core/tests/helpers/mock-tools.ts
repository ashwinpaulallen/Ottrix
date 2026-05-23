import { FunctionTool } from '../../src/tools/function-tool.js';
import { calculatorTool } from '../fixtures/tools.js';

export { calculatorTool } from '../fixtures/tools.js';

/** Echoes a string field from input. */
export const echoTool = new FunctionTool({
  name: 'echo',
  description: 'Echoes the message field',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  execute: async (input: Record<string, unknown>) => {
    const message = typeof input.message === 'string' ? input.message : '';
    return { echoed: message };
  },
});

/** Always throws — for error-handling integration tests. */
export const errorThrowerTool = new FunctionTool({
  name: 'error_thrower',
  description: 'Throws an error on every invocation',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('Tool execution failed intentionally');
  },
});

/** No-op tool for budget / step limit scenarios. */
export const noopTool = new FunctionTool({
  name: 'noop',
  description: 'Returns ok without side effects',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => 'ok',
});

/** All standard mock tools for quick registration. */
export const standardMockTools = [calculatorTool, echoTool, errorThrowerTool, noopTool] as const;

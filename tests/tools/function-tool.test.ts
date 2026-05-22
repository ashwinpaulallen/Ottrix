import { describe, expect, it } from 'vitest';
import { FunctionTool } from '../../src/tools/function-tool.js';

describe('FunctionTool', () => {
  it('delegates to the provided execute function', async () => {
    const tool = new FunctionTool({
      name: 'double',
      description: 'doubles a number',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async (input: Record<string, unknown>) => Number(input.value) * 2,
    });

    const result = await tool.execute({ value: 21 });
    expect(result.success).toBe(true);
    expect(result.output).toBe(42);
  });

  it('surfaces thrown errors as ToolResult failures', async () => {
    const tool = new FunctionTool({
      name: 'fail',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('boom');
      },
    });

    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});

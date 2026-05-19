import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createTool, ZodTool } from '../../src/tools/zod-tool.js';
import { calculatorTool } from '../fixtures/tools.js';

describe('ZodTool', () => {
  it('executes with valid input and returns typed output', async () => {
    const execute = vi.fn(async ({ city, units }: { city: string; units: string }) => ({
      temperature: 22,
      condition: 'sunny',
      city,
      units,
    }));

    const tool = createTool({
      name: 'get_weather',
      description: 'Get current weather for a city',
      input: z.object({
        city: z.string().describe('City name'),
        units: z.enum(['celsius', 'fahrenheit']),
      }),
      output: z.object({
        temperature: z.number(),
        condition: z.string(),
      }),
      execute,
    });

    const result = await tool.execute({ city: 'Paris', units: 'celsius' });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ temperature: 22, condition: 'sunny' });
    expect(execute).toHaveBeenCalledWith({ city: 'Paris', units: 'celsius' });
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.zodSchema).toBeDefined();
  });

  it('returns validation error without executing when input is invalid', async () => {
    const execute = vi.fn(async () => ({ ok: true }));

    const tool = createTool({
      name: 'strict',
      description: 'Requires a city',
      input: z.object({
        city: z.string().min(1),
      }),
      execute,
    });

    const result = await tool.execute({ city: '' });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.errorDetails?.name).toBe('ToolValidationError');
    expect(result.errorDetails?.data).toMatchObject({ stage: 'input' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates output when an output schema is provided', async () => {
    const tool = createTool({
      name: 'bad_output',
      description: 'Returns invalid output shape',
      input: z.object({ city: z.string() }),
      output: z.object({
        temperature: z.number(),
        condition: z.string(),
      }),
      execute: async () => ({ temperature: 'hot', condition: 42 }) as unknown as {
        temperature: number;
        condition: string;
      },
    });

    const result = await tool.execute({ city: 'Paris' });

    expect(result.success).toBe(false);
    expect(result.errorDetails?.data).toMatchObject({ stage: 'output' });
  });

  it('applies Zod defaults before execute', async () => {
    const execute = vi.fn(async (input: { city: string; units: 'celsius' | 'fahrenheit' }) => input);

    const tool = createTool({
      name: 'weather_defaults',
      description: 'Weather with default units',
      input: z.object({
        city: z.string(),
        units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
      }),
      execute,
    });

    const result = await tool.execute({ city: 'London' });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith({ city: 'London', units: 'celsius' });
    expect(result.output).toEqual({ city: 'London', units: 'celsius' });
  });

  it('exposes JSON Schema from Zod for LLM registration', () => {
    const tool = createTool({
      name: 'echo',
      description: 'Echo',
      input: z.object({ message: z.string() }),
      execute: async ({ message }) => message,
    });

    const definition = tool.toDefinition();
    expect(definition.inputSchema).toEqual(tool.inputSchema);
    expect(definition.inputSchema.properties?.message).toBeDefined();
  });
});

describe('createTool factory', () => {
  it('works end-to-end through ToolRegistry', async () => {
    const registry = new ToolRegistry();
    const tool = createTool({
      name: 'add',
      description: 'Adds two numbers',
      input: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    });

    registry.register(tool);

    const result = await registry.execute('add', { a: 2, b: 3 });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ sum: 5 });
    expect(registry.getZodSchema('add')).toBe(tool.zodSchema);
  });
});

describe('backward compatibility', () => {
  it('legacy FunctionTool with JSON Schema still works unchanged', async () => {
    const tool = new FunctionTool({
      name: 'legacy',
      description: 'Legacy tool',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async (input) => Number(input.value) * 2,
    });

    const result = await tool.execute({ value: 10 });
    expect(result.success).toBe(true);
    expect(result.output).toBe(20);
    expect(tool).not.toBeInstanceOf(ZodTool);
  });

  it('ToolRegistry lists Zod and legacy tools uniformly as JSON Schema', async () => {
    const registry = new ToolRegistry();
    const zodTool = createTool({
      name: 'zod_echo',
      description: 'Zod echo',
      input: z.object({ text: z.string() }),
      execute: async ({ text }) => text,
    });

    registry.register(zodTool).register(calculatorTool);

    const definitions = registry.list();
    expect(definitions).toHaveLength(2);
    for (const def of definitions) {
      expect(def.inputSchema.type).toBe('object');
    }

    expect(registry.getZodSchema('zod_echo')).toBe(zodTool.zodSchema);
    expect(registry.getZodSchema('calculator')).toBeUndefined();
  });
});

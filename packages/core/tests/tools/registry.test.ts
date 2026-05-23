import { describe, expect, it, vi } from 'vitest';
import { DuplicateToolError, ToolRegistry } from '../../src/tools/registry.js';
import {
  calculatorTool,
  fileReaderTool,
  fixtureTools,
  weatherLookupTool,
} from '../fixtures/tools.js';

describe('ToolRegistry', () => {
  it('registers, lists, and executes tools', async () => {
    const registry = new ToolRegistry();
    for (const tool of fixtureTools) {
      registry.register(tool);
    }

    expect(registry.names()).toHaveLength(3);
    expect(registry.list().map((d) => d.name)).toContain('calculator');

    const calc = await registry.execute('calculator', { expression: '2 + 3' });
    expect(calc.success).toBe(true);
    expect(calc.output).toEqual({ result: 5 });
  });

  it('supports namespaced tool names', async () => {
    const registry = new ToolRegistry();
    registry.register(weatherLookupTool).register(fileReaderTool);

    const weather = await registry.execute('weather.lookup', { city: 'London' });
    expect(weather.success).toBe(true);
    expect(weather.output).toEqual({ tempF: 58, condition: 'cloudy' });

    const defs = registry.listByNamespace('weather');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('weather.lookup');
  });

  it('registerFromSchema creates a dynamic tool', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      greeted: `hi ${typeof input.name === 'string' ? input.name : ''}`,
    }));

    registry.registerFromSchema(
      {
        name: 'greet',
        description: 'Says hi',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      execute,
    );

    const result = await registry.execute('greet', { name: 'Ada' });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith({ name: 'Ada' });
    expect(result.output).toEqual({ greeted: 'hi Ada' });
  });

  it('unregisters tools and namespaces', () => {
    const registry = new ToolRegistry();
    registry.register(weatherLookupTool).register(fileReaderTool).register(calculatorTool);

    expect(registry.unregister('calculator')).toBe(true);
    expect(registry.has('calculator')).toBe(false);

    const removed = registry.unregisterNamespace('files');
    expect(removed).toBe(1);
    expect(registry.has('files.read')).toBe(false);
  });

  it('throws when executing an unknown tool', async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute('missing', {})).rejects.toThrow('not registered');
  });

  it('reads mock files via files.read fixture', async () => {
    const registry = new ToolRegistry();
    registry.register(fileReaderTool);

    const result = await registry.execute('files.read', { path: 'readme.txt' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      path: 'readme.txt',
      content: 'Welcome to Ottrix.',
    });
  });

  it('returns error for missing mock file', async () => {
    const registry = new ToolRegistry();
    registry.register(fileReaderTool);

    const result = await registry.execute('files.read', { path: 'missing.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('overwrites duplicates by default', () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool).register(calculatorTool);
    expect(registry.names()).toEqual(['calculator']);
  });

  it('throws on duplicate when configured', () => {
    const registry = new ToolRegistry({ onDuplicate: 'throw' });
    registry.register(calculatorTool);
    expect(() => registry.register(calculatorTool)).toThrow(DuplicateToolError);
  });

  it('ignores duplicates when configured', () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    registry.register(weatherLookupTool, { onDuplicate: 'throw' });
    registry.register(calculatorTool, { onDuplicate: 'ignore' });
    expect(registry.names()).toHaveLength(2);
  });
});

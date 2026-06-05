import { describe, expect, it } from 'vitest';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { defineToolRegistry, pickTools } from '../../src/tools/tool-registry-builder.js';

describe('defineToolRegistry', () => {
  const search = new FunctionTool({
    name: 'search',
    description: 'Search',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

  const details = new FunctionTool({
    name: 'details',
    description: 'Details',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

  it('exposes frozen tool names', () => {
    const registry = defineToolRegistry({
      search,
      details,
    });

    expect(registry.names).toEqual(['search', 'details']);
    expect(registry.search).toBe(search);
  });

  it('pickTools returns tools by typed name', () => {
    const registry = defineToolRegistry({ search, details });
    expect(pickTools(registry, 'search', 'details')).toEqual([search, details]);
  });

  it('pickTools throws for unknown names', () => {
    const registry = defineToolRegistry({ search });
    expect(() => pickTools(registry, 'missing' as 'search')).toThrow(
      'Tool "missing" is not defined in the registry',
    );
  });
});

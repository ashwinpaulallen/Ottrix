import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createTool } from '../../src/tools/zod-tool.js';

const echo = async () => 'ok';

describe('ToolRegistry.getRoutingDescriptors', () => {
  it('includes a tool without routing metadata and applies defaults', () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'echo',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: {} },
        execute: echo,
      }),
    );

    expect(registry.getRoutingDescriptors()).toEqual([
      {
        name: 'echo',
        description: 'Echoes input',
        priority: 0,
        sideEffect: 'none',
        requiresApproval: false,
        idempotent: false,
      },
    ]);
  });

  it('copies routing metadata onto the descriptor', () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'charge',
        description: 'Charge a saved card',
        input: z.object({ amount: z.number() }),
        metadata: {
          sideEffect: 'write',
          requiresApproval: true,
          idempotent: true,
          routing: {
            description: 'Take payment',
            keywords: ['pay', 'charge'],
            examples: ['charge $20'],
            priority: 4,
            hints: { costTier: 'low', latencyTier: 'fast' },
            safetyClass: 'sensitive',
          },
        },
        execute: async () => ({ charged: true }),
      }),
    );

    const [descriptor] = registry.getRoutingDescriptors();
    expect(descriptor).toMatchObject({
      name: 'charge',
      description: 'Charge a saved card',
      routingDescription: 'Take payment',
      keywords: ['pay', 'charge'],
      examples: ['charge $20'],
      priority: 4,
      hints: { costTier: 'low', latencyTier: 'fast' },
      safetyClass: 'sensitive',
      sideEffect: 'write',
      requiresApproval: true,
      idempotent: true,
    });
  });

  it('returns every registered tool', () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'alpha',
        description: 'First',
        inputSchema: { type: 'object' },
        execute: echo,
      }),
    );
    registry.register(
      new FunctionTool({
        name: 'beta',
        description: 'Second',
        inputSchema: { type: 'object' },
        execute: echo,
      }),
    );

    expect(registry.getRoutingDescriptors().map((tool) => tool.name)).toEqual(['alpha', 'beta']);
  });

  it('exposes safetyClass dangerous so gates can filter on it', () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'wipe',
        description: 'Delete all records',
        inputSchema: { type: 'object' },
        metadata: {
          routing: { safetyClass: 'dangerous' },
        },
        execute: echo,
      }),
    );

    expect(registry.getRoutingDescriptors()[0]?.safetyClass).toBe('dangerous');
  });
});

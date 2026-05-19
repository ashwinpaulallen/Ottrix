import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../src/agent/agent.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import {
  createAutoApproveHandler,
  createCallbackApprovalHandler,
} from '../../src/tools/approval-handlers.js';
import { ConfigurationError } from '../../src/tools/errors.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createTool } from '../../src/tools/zod-tool.js';
import {
  getToolApprovalDenialReason,
  isToolApprovalDenied,
} from '../../src/tools/tool-approval.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const lightUsage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };

describe('ToolRegistry approval gates', () => {
  it('executes normally when approved', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry().setApprovalHandler(createAutoApproveHandler());

    registry.register(
      new FunctionTool({
        name: 'gated',
        description: 'Needs approval',
        inputSchema: { type: 'object', properties: {} },
        requiresApproval: true,
        execute,
      }),
    );

    const result = await registry.execute('gated', {}, { agentName: 'test-agent', stepNumber: 2 });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns denial without executing when denied', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry().setApprovalHandler(
      createCallbackApprovalHandler(async () => ({
        approved: false,
        reason: 'Too risky',
      })),
    );

    registry.register(
      new FunctionTool({
        name: 'gated',
        description: 'Needs approval',
        inputSchema: { type: 'object', properties: {} },
        metadata: { requiresApproval: true },
        execute,
      }),
    );

    const result = await registry.execute('gated', {});

    expect(result.success).toBe(false);
    expect(isToolApprovalDenied(result)).toBe(true);
    expect(getToolApprovalDenialReason(result)).toBe('Too risky');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes with modified input when approved with edits', async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => input);
    const registry = new ToolRegistry().setApprovalHandler(
      createCallbackApprovalHandler(async () => ({
        approved: true,
        modifiedInput: { city: 'Paris', units: 'celsius' },
      })),
    );

    registry.register(
      new FunctionTool({
        name: 'weather',
        description: 'Weather',
        inputSchema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            units: { type: 'string' },
          },
        },
        requiresApproval: true,
        execute,
      }),
    );

    const result = await registry.execute('weather', { city: 'London' });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith({ city: 'Paris', units: 'celsius' });
  });

  it('executes without approval when requiresApproval is false', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = new ToolRegistry();

    registry.register(
      new FunctionTool({
        name: 'open',
        description: 'Open tool',
        inputSchema: { type: 'object', properties: {} },
        execute,
      }),
    );

    const result = await registry.execute('open', {});

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('throws ConfigurationError when approval is required but no handler is set', async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FunctionTool({
        name: 'gated',
        description: 'Needs approval',
        inputSchema: { type: 'object', properties: {} },
        requiresApproval: true,
        execute: async () => 'ok',
      }),
    );

    await expect(registry.execute('gated', {})).rejects.toThrow(ConfigurationError);
    await expect(registry.execute('gated', {})).rejects.toThrow(
      "Tool 'gated' requires approval but no ApprovalHandler is registered",
    );
  });

  it('lists Zod and legacy tools uniformly with JSON Schema', () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'zod_tool',
        description: 'Zod',
        input: z.object({ x: z.string() }),
        metadata: { requiresApproval: true },
        execute: async () => 'ok',
      }),
    );
    registry.register(
      new FunctionTool({
        name: 'legacy_tool',
        description: 'Legacy',
        inputSchema: { type: 'object', properties: { y: { type: 'number' } } },
        execute: async () => 'ok',
      }),
    );

    const defs = registry.list();
    expect(defs).toHaveLength(2);
    for (const def of defs) {
      expect(def.inputSchema.type).toBe('object');
    }
    expect(registry.getZodSchema('zod_tool')).toBeDefined();
    expect(registry.getZodSchema('legacy_tool')).toBeUndefined();
  });

  it('uses per-tool approval handler override', async () => {
    const execute = vi.fn(async () => 'ran');
    const registry = new ToolRegistry().setApprovalHandler(
      createCallbackApprovalHandler(async () => ({ approved: false, reason: 'global deny' })),
    );

    registry
      .register(
        new FunctionTool({
          name: 'gated',
          description: 'Gated',
          inputSchema: { type: 'object', properties: {} },
          requiresApproval: true,
          execute,
        }),
      )
      .setToolApprovalHandler('gated', createAutoApproveHandler());

    const result = await registry.execute('gated', {});
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('createTool with approval metadata', () => {
  it('applies Zod defaults before execute after approval', async () => {
    const execute = vi.fn(async (input: { city: string; units: 'celsius' | 'fahrenheit' }) => input);
    const tool = createTool({
      name: 'weather_defaults',
      description: 'Weather',
      input: z.object({
        city: z.string(),
        units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
      }),
      metadata: { requiresApproval: true },
      execute,
    });

    const registry = new ToolRegistry()
      .setApprovalHandler(createAutoApproveHandler())
      .register(tool);

    const result = await registry.execute('weather_defaults', { city: 'Berlin' });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith({ city: 'Berlin', units: 'celsius' });
  });
});

describe('Agent tool approval', () => {
  it('continues the ReAct loop and adapts after a tool denial', async () => {
    const execute = vi.fn(async () => 'should not run');
    const registry = new ToolRegistry().setApprovalHandler(
      createCallbackApprovalHandler(async () => ({
        approved: false,
        reason: 'Policy block',
      })),
    );

    registry.register(
      new FunctionTool({
        name: 'dangerous',
        description: 'Dangerous action',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string' } },
          required: ['action'],
        },
        requiresApproval: true,
        execute,
      }),
    );

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'dangerous', input: { action: 'delete_all' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('I will use a safer read-only approach instead.', lightUsage));

    const deniedEvents: Array<{ toolName: string; reason: string }> = [];
    const agent = new Agent({
      name: 'approval-agent',
      provider,
      toolRegistry: registry,
      onAgentEvent: (event) => {
        if (event.type === 'tool_denied') {
          deniedEvents.push(event.data as { toolName: string; reason: string });
        }
      },
    });

    const result = await agent.run('Please delete everything');

    expect(execute).not.toHaveBeenCalled();
    expect(deniedEvents).toEqual([{ toolName: 'dangerous', reason: 'Policy block' }]);
    expect(result.metadata.stopReason).toBe('completed');
    expect(result.response).toContain('safer');
    expect(provider.completeCalls).toBe(2);

    const toolResultStep = result.steps.find(
      (s) => s.type === 'tool_result' && s.content && typeof s.content === 'object',
    );
    const toolResult = toolResultStep?.content as { success?: boolean; error?: string } | undefined;
    expect(toolResult?.success).toBe(false);
    expect(toolResult?.error).toContain('denied by the approval system');
  });
});

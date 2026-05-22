import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MCPClient } from '../../src/tools/mcp/client.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createTool } from '../../src/tools/zod-tool.js';
import {
  applyAuditFilter,
  defaultMcpToolClassifier,
  TOOL_SAFETY_BLOCKED_NAME,
} from '../../src/tools/tool-safety.js';
import { Logger } from '../../src/observability/logger.js';
import { FakeMCPTransport } from '../fixtures/fake-mcp-transport.js';
import { calculatorTool } from '../fixtures/tools.js';

const FAKE_CONFIG = { transport: 'sse', url: 'http://unused' } as const;

describe('Tool safety metadata', () => {
  it('tool with sideEffect none executes normally without safety checks', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'echo',
        description: 'echo',
        input: z.object({ message: z.string() }),
        sideEffect: 'none',
        execute: async ({ message }: { message: string }) => message,
      }),
    );

    const result = await registry.execute('echo', { message: 'hi' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hi');
  });

  it('tool with sideEffect destructive + requiresApproval is blocked without approval', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'delete_item',
        description: 'delete',
        input: z.object({ id: z.string() }),
        sideEffect: 'destructive',
        requiresApproval: true,
        execute: async () => ({ deleted: true }),
      }),
    );

    const result = await registry.execute('delete_item', { id: '1' });
    expect(result.success).toBe(false);
    expect(result.errorDetails?.name).toBe(TOOL_SAFETY_BLOCKED_NAME);
    expect(result.error).toMatch(/requires approval/i);
  });

  it('destructive + requiresApproval executes when approval handler approves', async () => {
    const registry = new ToolRegistry({ approvalHandler: async () => ({ approved: true }) });
    registry.register(
      createTool({
        name: 'delete_item',
        description: 'delete',
        input: z.object({ id: z.string() }),
        sideEffect: 'destructive',
        requiresApproval: true,
        execute: async () => ({ deleted: true }),
      }),
    );

    const result = await registry.execute('delete_item', { id: '1' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ deleted: true });
  });

  it('destructive + requiresSandbox is blocked when sandbox is unavailable', async () => {
    const registry = new ToolRegistry({ sandboxAvailable: false });
    registry.register(
      createTool({
        name: 'danger',
        description: 'danger',
        input: z.object({}),
        sideEffect: 'destructive',
        requiresSandbox: true,
        execute: async () => 'ok',
      }),
    );

    const result = await registry.execute('danger', {});
    expect(result.success).toBe(false);
    expect(result.errorDetails?.data).toMatchObject({ code: 'sandbox_required' });
  });

  it('skipSafetyChecks bypasses destructive middleware', async () => {
    const registry = new ToolRegistry({ sandboxAvailable: false });
    registry.register(
      createTool({
        name: 'danger',
        description: 'danger',
        input: z.object({}),
        sideEffect: 'destructive',
        requiresSandbox: true,
        execute: async () => 'ok',
      }),
    );

    const result = await registry.execute('danger', {}, { skipSafetyChecks: true });
    expect(result.success).toBe(true);
    expect(result.output).toBe('ok');
  });
});

describe('ToolRegistry.toolDescriptors', () => {
  it('returns correct shape for all registered tools', () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    registry.register(
      createTool({
        name: 'safe_read',
        description: 'read',
        input: z.object({ path: z.string() }),
        sideEffect: 'read',
        idempotent: true,
        version: '2.0.0',
        execute: async () => null,
      }),
    );

    const descriptors = registry.toolDescriptors();
    expect(descriptors).toHaveLength(2);

    const safe = descriptors.find((d) => d.name === 'safe_read');
    expect(safe).toMatchObject({
      name: 'safe_read',
      description: 'read',
      version: '2.0.0',
      safety: {
        sideEffect: 'read',
        idempotent: true,
        requiresApproval: false,
        requiresSandbox: false,
      },
    });
    expect(safe?.inputSchema).toBeDefined();

    const calc = descriptors.find((d) => d.name === 'calculator');
    expect(calc?.safety.sideEffect).toBe('none');
  });
});

describe('MCP tool classification', () => {
  it('default classifier flags delete and deploy patterns', () => {
    expect(defaultMcpToolClassifier({ name: 'delete_user', inputSchema: { type: 'object' } })).toEqual({
      sideEffect: 'destructive',
      requiresApproval: true,
    });
    expect(defaultMcpToolClassifier({ name: 'deploy_app', inputSchema: { type: 'object' } })).toEqual({
      sideEffect: 'destructive',
      requiresApproval: true,
    });
    expect(defaultMcpToolClassifier({ name: 'force_sync', inputSchema: { type: 'object' } })).toEqual({
      sideEffect: 'destructive',
      requiresApproval: false,
    });
    expect(defaultMcpToolClassifier({ name: 'get_weather', inputSchema: { type: 'object' } })).toEqual({
      sideEffect: 'write',
      requiresApproval: false,
    });
  });

  it('MCP importTools classify hook applies metadata to imported tools', async () => {
    const transport = new FakeMCPTransport({
      tools: [{ name: 'custom_action', description: 'custom', inputSchema: { type: 'object', properties: {} } }],
    });
    const client = new MCPClient({ config: FAKE_CONFIG, transport });
    await client.connect();

    const tools = await client.importTools({
      namespace: 'svc',
      classify: () => ({
        sideEffect: 'destructive',
        requiresApproval: true,
        idempotent: false,
      }),
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('svc.custom_action');
    expect(tools[0]?.metadata).toMatchObject({
      sideEffect: 'destructive',
      requiresApproval: true,
      idempotent: false,
    });

    await client.disconnect();
  });
});

describe('Tool audit config', () => {
  it('respects include and exclude fields in emitted audit events', async () => {
    const auditEvents: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry({
      auditHandler: (event) => {
        auditEvents.push(event.input);
      },
    });

    registry.register(
      createTool({
        name: 'audit_me',
        description: 'audit',
        input: z.object({
          publicField: z.string(),
          secret: z.string(),
          other: z.string(),
        }),
        metadata: {
          audit: {
            include: ['publicField', 'secret', 'other'],
            exclude: ['secret'],
          },
        },
        execute: async ({ publicField }: { publicField: string }) => publicField,
      }),
    );

    await registry.execute('audit_me', {
      publicField: 'visible',
      secret: 'hunter2',
      other: 'data',
    });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toEqual({
      publicField: 'visible',
      secret: '[REDACTED]',
      other: 'data',
    });
  });

  it('applyAuditFilter redacts excluded fields', () => {
    expect(
      applyAuditFilter(
        { a: 1, b: 2, c: 3 },
        { include: ['a', 'b', 'c'], exclude: ['b'] },
      ),
    ).toEqual({ a: 1, b: '[REDACTED]', c: 3 });
  });
});

describe('Tool safety backward compatibility', () => {
  it('existing FunctionTool without metadata works unchanged', async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const result = await registry.execute('calculator', { expression: '1 + 1' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ result: 2 });
  });

  it('warns when destructive tool lacks approval at registration', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const registry = new ToolRegistry();

    registry.register(
      new FunctionTool({
        name: 'nuke',
        description: 'nuke',
        inputSchema: { type: 'object', properties: {} },
        metadata: { sideEffect: 'destructive' },
        execute: async () => 'boom',
      }),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "Tool 'nuke' is marked destructive but does not require approval",
      { toolName: 'nuke' },
    );

    warnSpy.mockRestore();
  });
});

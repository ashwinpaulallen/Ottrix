import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { AuditLogger } from '../../src/guardrails/audit.js';
import { BudgetGuardrail } from '../../src/guardrails/budget.js';
import { createGuardrails } from '../../src/guardrails/factory.js';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';
import { HumanApprovalGuardrail } from '../../src/guardrails/human-in-the-loop.js';
import { PiiDetector } from '../../src/guardrails/validators.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import {
  MockProvider,
  heavyUsage,
  lightUsage,
  textCompletion,
  toolUseCompletion,
} from '../helpers/mock-provider.js';
import { noopTool } from '../helpers/mock-tools.js';
import { assertStopReason, createQueuedAgent } from '../helpers/test-utils.js';

describe('integration: guardrails', () => {
  it('stops the agent when the budget guardrail exceeds token budget', async () => {
    const { middleware, config } = createGuardrails({
      agentName: 'budget-agent',
      budget: { maxTokenBudget: 100 },
    });

    const provider = new MockProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'noop', input: {} }], heavyUsage))
      .enqueue(textCompletion('done', lightUsage));

    const registry = new ToolRegistry();
    registry.register(noopTool);

    const agent = new Agent({
      name: 'budget-agent',
      provider,
      toolRegistry: registry,
      guardrailMiddleware: middleware,
      guardrails: config,
      maxSteps: 10,
    });

    const result = await agent.run('run until budget stops');

    assertStopReason(result, 'token_budget');
    expect(result.metadata.warning).toMatch(/token budget/i);
    expect(provider.completeCalls).toBe(1);
  });

  it('detects PII emails and phone numbers in LLM output', async () => {
    const detector = new PiiDetector({ mode: 'detect', blockOnDetect: true });
    const middleware = new GuardrailMiddleware([detector]);

    const post = await middleware.afterLlm({
      phase: 'llm',
      timing: 'post',
      agentName: 'pii-agent',
      messages: [],
      params: { messages: [] },
      result: textCompletion('Call me at user@example.com or (555) 123-4567', lightUsage),
    });

    expect(post.proceed).toBe(false);
    expect(post.reason).toMatch(/pii/i);

    const emailOnly = await detector.validate('reach me at secret@corp.com');
    const phoneOnly = await detector.validate('phone: 555-123-4567');
    expect(emailOnly.passed).toBe(false);
    expect(phoneOnly.passed).toBe(false);
  });

  it('blocks tool execution when human approval is denied', async () => {
    const dangerous = new FunctionTool({
      name: 'dangerous',
      description: 'Requires approval',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'should not run',
    });

    const middleware = new GuardrailMiddleware([
      new HumanApprovalGuardrail({
        shouldRequireApproval: (toolName) => toolName === 'dangerous',
        requestApproval: async () => false,
      }),
    ]);

    const provider = new MockProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'dangerous', input: {} }], lightUsage))
      .enqueue(textCompletion('Proceeding without tool.', lightUsage));

    const registry = new ToolRegistry();
    registry.register(dangerous);

    const agent = new Agent({
      name: 'hitl-deny',
      provider,
      toolRegistry: registry,
      guardrailMiddleware: middleware,
    });

    const result = await agent.run('Run dangerous tool');
    expect(result.response).toContain('Proceeding');
    expect(provider.completeCalls).toBe(2);
  });

  it('allows tool execution when human approval is granted', async () => {
    const dangerous = new FunctionTool({
      name: 'dangerous',
      description: 'Requires approval',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'executed safely',
    });

    let approvalCalls = 0;
    const middleware = new GuardrailMiddleware([
      new HumanApprovalGuardrail({
        shouldRequireApproval: () => true,
        requestApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      }),
    ]);

    const provider = new MockProvider()
      .enqueue(toolUseCompletion([{ id: 'tu_1', name: 'dangerous', input: {} }], lightUsage))
      .enqueue(textCompletion('Tool ran successfully.', lightUsage));

    const registry = new ToolRegistry();
    registry.register(dangerous);

    const agent = new Agent({
      name: 'hitl-approve',
      provider,
      toolRegistry: registry,
      guardrailMiddleware: middleware,
    });

    const result = await agent.run('Run dangerous tool');

    expect(approvalCalls).toBe(1);
    expect(result.response).toBe('Tool ran successfully.');
    expect(provider.completeCalls).toBe(2);
  });

  it('audit logger captures LLM and tool events during an agent run', async () => {
    const audit = new AuditLogger({ agentName: 'audited', console: false });
    const budget = new BudgetGuardrail({ maxSteps: 5 });
    const middleware = new GuardrailMiddleware([audit, budget]);

    const tool = new FunctionTool({
      name: 'audit_echo',
      description: 'Echo for audit trail',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute: async (input: Record<string, unknown>) => {
        const value = input.value;
        return typeof value === 'string' ? value : '';
      },
    });

    const provider = new MockProvider()
      .enqueue(
        toolUseCompletion(
          [{ id: 'tu_1', name: 'audit_echo', input: { value: 'test' } }],
          lightUsage,
        ),
      )
      .enqueue(textCompletion('Audit run complete.', lightUsage));

    const registry = new ToolRegistry();
    registry.register(tool);

    const agent = createQueuedAgent(provider, {
      name: 'audited',
      tools: [tool],
      guardrailMiddleware: middleware,
    });

    await agent.run('Run audited flow');

    const types = audit.getLogs().map((entry) => entry.type);
    expect(types).toContain('llm_pre');
    expect(types).toContain('llm_post');
    expect(types).toContain('tool_post');
    expect(audit.getLogs().length).toBeGreaterThanOrEqual(3);

    const exported = JSON.parse(audit.exportLogs()) as Array<{ agentName: string }>;
    expect(exported.every((e) => e.agentName === 'audited')).toBe(true);
  });
});

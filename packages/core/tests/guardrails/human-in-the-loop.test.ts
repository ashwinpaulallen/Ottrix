import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';
import { HumanApprovalGuardrail } from '../../src/guardrails/human-in-the-loop.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

describe('HumanApprovalGuardrail', () => {
  it('denies tool execution when approval is rejected', async () => {
    let approvalRequested = false;

    const middleware = new GuardrailMiddleware([
      new HumanApprovalGuardrail({
        shouldRequireApproval: (toolName) => toolName === 'dangerous',
        requestApproval: async () => {
          approvalRequested = true;
          return false;
        },
      }),
    ]);

    const dangerous = new FunctionTool({
      name: 'dangerous',
      description: 'High stakes',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'should not run',
    });

    const provider = new MockCompletionProvider()
      .enqueue(
        toolUseCompletion([{ id: 'tu_1', name: 'dangerous', input: {} }], {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
        }),
      )
      .enqueue(textCompletion('Acknowledged denial.', { inputTokens: 5, outputTokens: 3, totalTokens: 8 }));

    const registry = new ToolRegistry();
    registry.register(dangerous);

    const agent = new Agent({
      name: 'hitl',
      provider,
      toolRegistry: registry,
      guardrailMiddleware: middleware,
    });

    const result = await agent.run('Run dangerous action');

    expect(approvalRequested).toBe(true);
    expect(result.response).toContain('Acknowledged');
    expect(dangerous).toBeDefined();
    expect(provider.completeCalls).toBe(2);
  });
});

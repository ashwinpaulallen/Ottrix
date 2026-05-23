import type { AgentStep } from '../types/agent.js';
import { emitAuditEvent } from './audit.js';
import type { GuardrailDecision, GuardrailHandler, ToolGuardrailContext } from './types.js';

/** Options for {@link HumanApprovalGuardrail}. */
export interface HumanApprovalGuardrailOptions {
  /**
   * Return `true` when a tool call requires human approval before execution.
   */
  shouldRequireApproval: (toolName: string, input: unknown) => boolean;
  /**
   * Request approval from a human (CLI, webhook, UI, etc.).
   * Return `true` to allow the tool call, `false` to deny.
   */
  requestApproval: (step: AgentStep) => Promise<boolean>;
}

/**
 * Pauses high-stakes tool calls until a human approves or denies them.
 */
export class HumanApprovalGuardrail implements GuardrailHandler {
  readonly name = 'human-approval';
  private readonly shouldRequireApproval: HumanApprovalGuardrailOptions['shouldRequireApproval'];
  private readonly requestApproval: HumanApprovalGuardrailOptions['requestApproval'];

  constructor(options: HumanApprovalGuardrailOptions) {
    this.shouldRequireApproval = options.shouldRequireApproval;
    this.requestApproval = options.requestApproval;
  }

  async beforeTool(context: ToolGuardrailContext): Promise<GuardrailDecision | void> {
    if (!this.shouldRequireApproval(context.toolName, context.input)) {
      return;
    }

    const step: AgentStep =
      context.pendingStep ??
      ({
        type: 'tool_call',
        content: { name: context.toolName, input: context.input },
        timestamp: Date.now(),
      } satisfies AgentStep);

    emitAuditEvent({
      type: 'approval.request',
      actor: { type: 'user', id: 'human-reviewer', name: 'human-reviewer' },
      action: 'request',
      resource: `tool:${context.toolName}`,
      outcome: 'success',
      payload: { toolName: context.toolName, input: context.input },
    });

    const approved = await this.requestApproval(step);

    emitAuditEvent({
      type: 'approval.decide',
      actor: { type: 'user', id: 'human-reviewer', name: 'human-reviewer' },
      action: approved ? 'approve' : 'deny',
      resource: `tool:${context.toolName}`,
      outcome: approved ? 'success' : 'denied',
      payload: { toolName: context.toolName },
    });
    if (approved) {
      return;
    }

    return {
      action: 'block',
      code: 'guardrail',
      reason: `Human approval denied for tool "${context.toolName}"`,
      toolResultMessage:
        `Tool call "${context.toolName}" was denied by a human reviewer. ` +
        'Do not retry this action without revised instructions.',
    };
  }
}

import type { ApprovalRequest, ApprovalResponse, ToolResult } from '../types/tools.js';

/** Prefix for denial messages returned to the model. */
export const TOOL_APPROVAL_DENIED_PREFIX = 'Tool execution denied:';

/** Error details name for approval denials. */
export const TOOL_APPROVAL_DENIED_NAME = 'ToolApprovalDenied';

/** Whether a {@link ToolResult} represents an approval denial (tool was not executed). */
export function isToolApprovalDenied(result: ToolResult | undefined): boolean {
  if (!result || result.success) {
    return false;
  }
  if (result.errorDetails?.name === TOOL_APPROVAL_DENIED_NAME) {
    return true;
  }
  return typeof result.error === 'string' && result.error.startsWith(TOOL_APPROVAL_DENIED_PREFIX);
}

/** Extract the denial reason from a {@link ToolResult}. */
export function getToolApprovalDenialReason(result: ToolResult): string {
  const data = result.errorDetails?.data;
  if (typeof data === 'object' && data !== null && 'reason' in data) {
    const reason = (data as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) {
      return reason;
    }
  }
  if (typeof result.error === 'string' && result.error.startsWith(TOOL_APPROVAL_DENIED_PREFIX)) {
    return result.error.slice(TOOL_APPROVAL_DENIED_PREFIX.length).trim() || 'No reason provided';
  }
  return 'No reason provided';
}

/** Build the model-facing message after a tool denial. */
export function buildToolApprovalDenialMessage(result: ToolResult): string {
  const reason = getToolApprovalDenialReason(result);
  return `The tool call was denied by the approval system. Reason: ${reason}. Please adjust your approach.`;
}

/** Build a {@link ToolResult} for a denied approval (does not execute the tool). */
export function buildToolApprovalDeniedResult(reason?: string): ToolResult {
  const resolvedReason = reason?.trim() || 'No reason provided';
  return {
    success: false,
    output: null,
    error: `${TOOL_APPROVAL_DENIED_PREFIX} ${resolvedReason}`,
    errorDetails: {
      name: TOOL_APPROVAL_DENIED_NAME,
      data: { reason: resolvedReason, denied: true },
    },
  };
}

/** Build an {@link ApprovalRequest} for registry execution. */
export function buildApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: {
    agentName?: string;
    stepNumber?: number;
    context?: string;
  } = {},
): ApprovalRequest {
  return {
    toolName,
    input,
    agentName: options.agentName ?? 'agent',
    stepNumber: options.stepNumber ?? 0,
    context: options.context,
  };
}

/** Resolve the effective input after an approval response. */
export function resolveApprovedInput(
  originalInput: Record<string, unknown>,
  response: ApprovalResponse,
): Record<string, unknown> {
  return response.modifiedInput ?? originalInput;
}

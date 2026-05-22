import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '../types/tools.js';

/**
 * CLI approval handler — prompts on stdin with y/n after showing the tool call.
 */
export function createCliApprovalHandler(): ApprovalHandler {
  return async (request: ApprovalRequest): Promise<ApprovalResponse> => {
    const rl = readline.createInterface({ input, output });
    try {
      const lines = [
        '',
        '--- Tool approval required ---',
        `Agent: ${request.agentName}`,
        `Step: ${request.stepNumber}`,
        `Tool: ${request.toolName}`,
        `Input: ${JSON.stringify(request.input, null, 2)}`,
      ];
      if (request.context) {
        lines.push(`Context: ${request.context}`);
      }
      lines.push('Approve this tool call? (y/n): ');
      output.write(lines.join('\n'));

      const answer = (await rl.question('')).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        return { approved: true };
      }

      return {
        approved: false,
        reason: answer.length > 0 ? answer : 'Denied via CLI',
      };
    } finally {
      rl.close();
    }
  };
}

/**
 * Always approves tool calls (useful for tests and local development).
 */
export function createAutoApproveHandler(): ApprovalHandler {
  return async () => ({ approved: true });
}

/**
 * Wraps a custom async approval function for UI or policy integration.
 */
export function createCallbackApprovalHandler(
  callback: ApprovalHandler,
): ApprovalHandler {
  return callback;
}

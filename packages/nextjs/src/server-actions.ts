import type { Agent, AgentResult } from 'ottrix';
import type { RunContext } from 'ottrix';
import { runWith } from 'ottrix';
import { isRunContextSupported } from './helpers.js';

/**
 * Run an ottrix agent from a React Server Action with optional RunContext.
 * RunContext is skipped on Edge runtime where AsyncLocalStorage is unavailable.
 */
export async function runAgent(
  agent: Agent,
  message: string,
  options?: { runContext?: Partial<RunContext> },
): Promise<AgentResult> {
  const execute = () => agent.run(message);

  if (!isRunContextSupported()) {
    return execute();
  }

  const ctx: RunContext = {
    runId: options?.runContext?.runId ?? crypto.randomUUID(),
    ...options?.runContext,
  };

  return runWith(ctx, execute);
}

import type { Agent } from '../agent/agent.js';
import type { AgentResult } from '../types/agent.js';
import type { Reflector } from '../agent/reflector.js';
import type { WorkflowConfig, WorkflowStep } from './types.js';

const DEFAULT_STEP_TIMEOUT_MS = 120_000;

/** Error thrown when an agent step exceeds its timeout. */
export class WorkflowTimeoutError extends Error {
  readonly agentName: string;

  constructor(agentName: string, timeoutMs: number) {
    super(`Agent "${agentName}" timed out after ${timeoutMs}ms`);
    this.name = 'WorkflowTimeoutError';
    this.agentName = agentName;
  }
}

/** Run an agent with optional timeout, fallback, and hooks. */
export async function runAgentStep(options: {
  agent: Agent;
  agentName?: string;
  input: string;
  config?: WorkflowConfig;
  timeoutMs?: number;
  fallback?: (error: Error) => AgentResult | Promise<AgentResult>;
}): Promise<WorkflowStep> {
  const agentName = options.agentName ?? options.agent.getName();
  const timeoutMs = options.timeoutMs ?? options.config?.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
  const started = Date.now();

  try {
    const result = await runWithTimeout(
      () => options.agent.run(options.input),
      timeoutMs,
      agentName,
    );

    const step: WorkflowStep = {
      agentName,
      input: options.input,
      result,
      duration: Date.now() - started,
    };

    await options.config?.onStepComplete?.(step);
    return step;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const action = await options.config?.onError?.(err, { agentName, input: options.input });

    if (action === 'abort') {
      throw err;
    }

    if (options.fallback) {
      const result = await options.fallback(err);
      const step: WorkflowStep = {
        agentName,
        input: options.input,
        result,
        duration: Date.now() - started,
        error: err,
      };
      await options.config?.onStepComplete?.(step);
      return step;
    }

    throw err;
  }
}

/** Check whether a reflector considers the goal already satisfied. */
export async function isGoalMet(
  reflector: Reflector,
  result: AgentResult,
  goal: string,
): Promise<boolean> {
  const evaluation = await reflector.evaluateResult(result, goal);
  return evaluation.goalMet;
}

/** Build a workflow-level {@link AgentResult} from the last step. */
export function finalResultFromStep(step: WorkflowStep): AgentResult {
  return step.result;
}

/** Merge token usage from multiple agent results. */
export function mergeTokenUsage(results: AgentResult[]): AgentResult['totalTokens'] {
  return results.reduce(
    (acc, result) => ({
      inputTokens: acc.inputTokens + result.totalTokens.inputTokens,
      outputTokens: acc.outputTokens + result.totalTokens.outputTokens,
      totalTokens: acc.totalTokens + result.totalTokens.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  agentName: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WorkflowTimeoutError(agentName, timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    fn()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

/** Run tasks with a concurrency limit while preserving result order. */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const limit = Math.max(1, concurrency);
  const results: T[] = [];

  for (let start = 0; start < tasks.length; start += limit) {
    const batch = tasks.slice(start, start + limit);
    const batchResults = await Promise.all(batch.map((task) => task()));
    results.push(...batchResults);
  }

  return results;
}

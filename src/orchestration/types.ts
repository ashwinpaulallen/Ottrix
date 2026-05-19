import type { AgentResult } from '../types/agent.js';

/** Record of a single agent invocation within a workflow. */
export interface WorkflowStep {
  /** Configured agent name. */
  agentName: string;
  /** Input passed to the agent. */
  input: string;
  /** Agent run outcome. */
  result: AgentResult;
  /** Wall-clock duration of the step in milliseconds. */
  duration: number;
  /** Set when the step failed but the workflow continued (e.g. parallel with fallback). */
  error?: Error;
}

/** Outcome of a multi-agent workflow run. */
export interface WorkflowResult {
  /** Final aggregated agent result. */
  finalResult: AgentResult;
  /** Per-agent step trace in execution order. */
  steps: WorkflowStep[];
  /** Total workflow duration in milliseconds. */
  duration: number;
  /** True when the workflow stopped before all steps (e.g. reflector early exit). */
  earlyTerminated?: boolean;
  /** Top-level workflow error when the run failed. */
  error?: Error;
}

/** Shared workflow runtime options. */
export interface WorkflowConfig {
  /** Per-step timeout in milliseconds. */
  timeout?: number;
  /** Called after each agent step completes successfully. */
  onStepComplete?: (step: WorkflowStep) => void | Promise<void>;
  /**
   * Called when a step fails.
   * Return `'continue'` to keep going (parallel), `'abort'` to stop the workflow.
   */
  onError?: (
    error: Error,
    step: Pick<WorkflowStep, 'agentName' | 'input'>,
  ) => 'continue' | 'abort' | void | Promise<'continue' | 'abort' | void>;
}

/** Context passed to sequential input mappers. */
export interface SequentialMapperContext {
  /** Original workflow input. */
  originalInput: string;
  /** Zero-based step index. */
  stepIndex: number;
  /** Results from all prior steps. */
  priorSteps: WorkflowStep[];
}

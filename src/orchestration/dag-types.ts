/** Context passed to each {@link DAGStep.execute} invocation. */
export interface StepContext {
  /** Initial workflow input passed to {@link DAGWorkflow.run}. */
  workflowInput: unknown;
  /** ID of the step being executed. */
  stepId: string;
  /** Zero-based attempt index (0 = first attempt). */
  attempt: number;
  /** Aborted when the step times out or the workflow is cancelled. */
  signal: AbortSignal;
  /** Active {@link RunContext} from AsyncLocalStorage, when available. */
  runContext?: import('../context/run-context.js').RunContext;
}

/**
 * A single node in a {@link DAGWorkflow}.
 *
 * Step outputs stored in {@link SuspendedWorkflowState} must be JSON-serializable
 * (plain objects, arrays, strings, numbers, booleans, or null).
 */
export interface DAGStep<TInput = unknown, TOutput = unknown> {
  /** Unique step identifier. */
  id: string;
  /** Human-readable step name. */
  name: string;
  /** Step implementation. */
  execute: (input: TInput, context: StepContext) => Promise<TOutput>;
  /** IDs of steps that must complete before this step runs. */
  dependencies?: string[];
  /** Maps dependency outputs to this step's input. */
  inputMapper?: (depOutputs: Record<string, unknown>) => TInput;
  /** Number of retries after the first failure. @defaultValue 0 */
  retries?: number;
  /** Step timeout in milliseconds. */
  timeout?: number;
  /** When false, the step is skipped and dependents receive `undefined` for this output. */
  condition?: (depOutputs: Record<string, unknown>) => boolean;
  /**
   * When true, the workflow pauses before executing this step and waits for
   * {@link DAGWorkflow.resume} with human-provided output.
   */
  suspend?: boolean;
  /** Human approval gate configuration when this step is created via {@link humanApproval}. */
  approvalGate?: import('./human-approval.js').ApprovalGateConfig;
}

/** Configuration for {@link DAGWorkflow}. */
export interface DAGWorkflowConfig {
  /** All steps in the workflow graph. */
  steps: DAGStep[];
  /** Default input for root steps when {@link DAGWorkflow.run} receives no argument. */
  input?: unknown;
  /** Maximum number of steps executing concurrently. @defaultValue Infinity */
  maxConcurrency?: number;
  /** Called after a step completes successfully. */
  onStepComplete?: (stepId: string, output: unknown, duration: number) => void;
  /** Called when a step fails after all retries. */
  onStepError?: (stepId: string, error: Error) => void;
  /** Optional store for auto-persisting suspended workflow state. */
  stateStore?: import('./state-store.js').WorkflowStateStore;
  /** Default metadata applied when persisting suspended state. */
  saveMeta?: import('./state-store.js').SaveMeta;
  /** Lock TTL in milliseconds for suspend/resume coordination. @defaultValue 60000 */
  lockTtlMs?: number;
  /** Store for human approval gate audit trails. */
  approvalStore?: import('./human-approval.js').ApprovalStore;
  /** Secret used when approval gates sign decisions as JWTs. */
  approvalSignerSecret?: string;
}

/** Serializable snapshot of a paused workflow. Safe for JSON.stringify / JSON.parse. */
export interface SuspendedWorkflowState {
  /** Unique workflow run identifier. */
  workflowId: string;
  /** Sorted step IDs for validating resume against the workflow definition. */
  stepIds?: string[];
  /** Outputs for steps completed before suspension, keyed by step ID. */
  completedSteps: Record<string, unknown>;
  /** Step IDs skipped before suspension. */
  skippedSteps: string[];
  /** Durations in milliseconds for completed/skipped steps before suspension. */
  stepDurations: Record<string, number>;
  /** Step ID of the suspension point (not yet executed). */
  currentStepId: string;
  /** Unix epoch milliseconds when suspension occurred. */
  suspendedAt: number;
  /** Original workflow input from {@link DAGWorkflow.run}. */
  workflowInput: unknown;
  /** Input prepared for the suspended step (dependency outputs mapped). */
  pendingStepInput?: unknown;
  /** Human-readable description of input needed to resume. */
  suspensionMessage?: string;
  /** Optional opaque metadata persisted across suspend/resume. */
  metadata?: Record<string, unknown>;
}

/** Input for {@link DAGWorkflow.resume}. */
export interface ResumeInput {
  /** Must match {@link SuspendedWorkflowState.workflowId}. */
  workflowId: string;
  /** Human-provided output injected as the suspended step's result. */
  stepOutput: unknown;
  /** Optional metadata merged into the resumed execution state. */
  metadata?: Record<string, unknown>;
}

/** Outcome of {@link DAGWorkflow.run} or {@link DAGWorkflow.resume}. */
export interface DAGResult {
  /** Terminal status of the workflow run. */
  status: 'completed' | 'suspended' | 'failed';
  /** Output of each completed step keyed by step ID. */
  outputs: Record<string, unknown>;
  /** Output of terminal step(s); a single value or a map when multiple terminals exist. */
  finalOutput: unknown;
  /** Total wall-clock duration in milliseconds. */
  duration: number;
  /** Per-step execution duration in milliseconds. */
  stepDurations: Record<string, number>;
  /** Step IDs skipped due to a false {@link DAGStep.condition}. */
  skippedSteps: string[];
  /** Step IDs that failed or were cascaded from a failed dependency. */
  failedSteps: string[];
  /** Present when {@link DAGResult.status} is `'suspended'`. */
  suspendedState?: SuspendedWorkflowState;
  /** Human-readable suspension prompt when status is `'suspended'`. */
  suspensionMessage?: string;
}

/** Thrown when the workflow graph contains a cycle. */
export class CyclicDependencyError extends Error {
  constructor(message = 'Workflow contains a cyclic dependency') {
    super(message);
    this.name = 'CyclicDependencyError';
  }
}

/** Thrown when a step exceeds its configured timeout. */
export class DAGStepTimeoutError extends Error {
  readonly stepId: string;

  constructor(stepId: string, timeoutMs: number) {
    super(`Step "${stepId}" timed out after ${timeoutMs}ms`);
    this.name = 'DAGStepTimeoutError';
    this.stepId = stepId;
  }
}

/** Thrown when the workflow is cancelled. */
export class DAGWorkflowCancelledError extends Error {
  constructor(message = 'Workflow cancelled') {
    super(message);
    this.name = 'DAGWorkflowCancelledError';
  }
}

/** Thrown when {@link DAGWorkflow.resume} receives an invalid state or workflow ID. */
export class WorkflowResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowResumeError';
  }
}

/** Thrown when a workflow suspends for human input (optional; prefer {@link DAGResult.status}). */
export class WorkflowSuspendedError extends Error {
  readonly state: SuspendedWorkflowState;

  constructor(state: SuspendedWorkflowState, message?: string) {
    super(message ?? state.suspensionMessage ?? `Workflow suspended at step "${state.currentStepId}"`);
    this.name = 'WorkflowSuspendedError';
    this.state = state;
  }
}

/** Internal step execution status. */
export type DAGStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

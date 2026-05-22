import { randomUUID } from 'node:crypto';
import type { Agent } from '../agent/agent.js';
import type { AgentResult } from '../types/agent.js';
import { getRunContext, runWith, withStep } from '../context/run-context.js';
import { emitAuditEvent } from '../guardrails/audit.js';
import {
  buildDependentsMap,
  buildFinalOutput,
  executeWithAbort,
  findTerminalStepIds,
  mapStepInput,
  throwIfAborted,
  validateDagSteps,
} from './dag-graph.js';
import {
  DAGStepTimeoutError,
  DAGWorkflowCancelledError,
  WorkflowResumeError,
  type DAGResult,
  type DAGStep,
  type DAGStepStatus,
  type DAGWorkflowConfig,
  type ResumeInput,
  type StepContext,
  type SuspendedWorkflowState,
} from './dag-types.js';
import {
  WorkflowStateLockError,
  type LockHandle,
  type SaveMeta,
  type WorkflowStateStore,
} from './state-store.js';
import {
  dispatchApprovalGate,
  handleApprovalResume,
  resolveApprovalStore,
  type ApprovalResumeOutcome,
} from './human-approval.js';

export {
  CyclicDependencyError,
  DAGStepTimeoutError,
  DAGWorkflowCancelledError,
  WorkflowResumeError,
  WorkflowSuspendedError,
  type DAGResult,
  type DAGStep,
  type DAGWorkflowConfig,
  type ResumeInput,
  type StepContext,
  type SuspendedWorkflowState,
} from './dag-types.js';

export {
  WorkflowStateLockError,
  StateStorePeerDependencyError,
  type WorkflowStateStore,
  type SaveMeta,
  type ListFilter,
  type SuspendedRunInfo,
  type LockHandle,
} from './state-store.js';

interface ExecutionSnapshot {
  workflowId: string;
  workflowInput: unknown;
  metadata: Record<string, unknown>;
  statuses: Map<string, DAGStepStatus>;
  outputs: Map<string, unknown>;
  stepDurations: Map<string, number>;
  skippedSteps: string[];
  failedSteps: string[];
}

/**
 * DAG-based workflow engine. Steps run as soon as their dependencies are satisfied,
 * up to {@link DAGWorkflowConfig.maxConcurrency}.
 */
export class DAGWorkflow {
  private readonly config: DAGWorkflowConfig;
  private readonly steps: Map<string, DAGStep>;
  private readonly dependents: Map<string, string[]>;
  private readonly topologicalOrder: string[];

  private cancelled = false;
  private workflowAbortController = new AbortController();
  private readonly activeControllers = new Set<AbortController>();

  /**
   * @param config - Workflow graph and execution options.
   * @throws {CyclicDependencyError} When the graph contains a cycle.
   */
  constructor(config: DAGWorkflowConfig) {
    this.config = config;
    this.steps = new Map(config.steps.map((step) => [step.id, step]));
    this.dependents = buildDependentsMap(config.steps);
    this.topologicalOrder = validateDagSteps(config.steps);
  }

  /** Abort all running steps and prevent new steps from starting. */
  cancel(): void {
    this.cancelled = true;
    this.workflowAbortController.abort();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
  }

  /** Whether {@link cancel} has been called on this workflow instance. */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Execute the workflow graph.
   *
   * @param input - Initial input for root steps; falls back to {@link DAGWorkflowConfig.input}.
   * @param options - Optional run configuration.
   */
  async run(
    input?: unknown,
    options?: { workflowId?: string },
  ): Promise<DAGResult> {
    const workflowInput = input ?? this.config.input;
    const workflowId = options?.workflowId ?? randomUUID();
    const existing = getRunContext();
    const result = await runWith(
      {
        ...existing,
        runId: (existing?.runId as string | undefined) ?? workflowId,
      },
      () =>
        this.execute(
          createInitialSnapshot(workflowId, workflowInput, [...this.steps.keys()]),
        ),
    );

    if (result.status === 'suspended' && result.suspendedState && this.config.stateStore) {
      await this.persistSuspendedState(result.suspendedState);
    }

    return result;
  }

  /**
   * Resume a suspended workflow.
   *
   * When a {@link DAGWorkflowConfig.stateStore} is configured, pass only {@link ResumeInput}
   * and the state is loaded automatically from the store.
   *
   * @param stateOrInput - Suspended state, or resume input when using a state store.
   * @param input - Human-provided output for the suspended step.
   */
  async resume(
    stateOrInput: SuspendedWorkflowState | ResumeInput,
    input?: ResumeInput,
  ): Promise<DAGResult> {
    let state: SuspendedWorkflowState;
    let resumeInput: ResumeInput;

    if (input !== undefined) {
      state = stateOrInput as SuspendedWorkflowState;
      resumeInput = input;
    } else if (this.config.stateStore) {
      resumeInput = stateOrInput as ResumeInput;
      const loaded = await this.config.stateStore.load(resumeInput.workflowId);
      if (!loaded) {
        throw new WorkflowResumeError(
          `No suspended state found for workflow "${resumeInput.workflowId}"`,
        );
      }
      state = loaded;
    } else {
      throw new WorkflowResumeError(
        'resume requires suspended state when no stateStore is configured',
      );
    }

    if (resumeInput.workflowId !== state.workflowId) {
      throw new WorkflowResumeError(
        `workflowId mismatch: expected "${state.workflowId}", received "${resumeInput.workflowId}"`,
      );
    }

    if (!this.steps.has(state.currentStepId)) {
      throw new WorkflowResumeError(
        `Suspended step "${state.currentStepId}" does not exist in this workflow`,
      );
    }

    if (state.stepIds) {
      const currentIds = [...this.steps.keys()].sort();
      const savedIds = [...state.stepIds].sort();
      if (currentIds.join('\0') !== savedIds.join('\0')) {
        throw new WorkflowResumeError('Workflow definition does not match the suspended state');
      }
    }

    const lock = await this.acquireResumeLock(state.workflowId);
    if (this.config.stateStore?.acquireLock && !lock) {
      throw new WorkflowStateLockError(state.workflowId);
    }

    try {
      let resumeInputForExecute = resumeInput;
      const step = this.steps.get(state.currentStepId);

      emitAuditEvent({
        type: 'workflow.resume',
        actor: { type: 'system', id: 'workflow', name: 'workflow' },
        action: 'resume',
        resource: `workflow:${state.workflowId}/step:${state.currentStepId}`,
        outcome: 'success',
      });

      if (step?.approvalGate) {
        const approvalStore = resolveApprovalStore(this.config.approvalStore, step.approvalGate);
        const upstreamStepId = step.dependencies?.[0];
        const approvalOutcome = await handleApprovalResume({
          gate: step.approvalGate,
          store: approvalStore,
          state,
          resumeInput,
          upstreamStepId,
          signerSecret: this.config.approvalSignerSecret,
        });

        const handled = await this.finalizeApprovalOutcome(
          approvalOutcome,
          state.currentStepId,
          state.workflowId,
          lock,
        );
        if (handled) {
          return handled;
        }

        resumeInputForExecute = {
          ...resumeInput,
          stepOutput: (approvalOutcome as Extract<ApprovalResumeOutcome, { kind: 'complete' }>).output,
        };
      }

      const snapshot = rehydrateSnapshot(state, resumeInputForExecute, [...this.steps.keys()]);
      const existing = getRunContext();
      const result = await runWith(
        {
          ...existing,
          runId: (existing?.runId as string | undefined) ?? state.workflowId,
        },
        () => this.execute(snapshot),
      );

      if (result.status === 'completed' && this.config.stateStore) {
        await this.config.stateStore.delete(state.workflowId);
      } else if (result.status === 'suspended' && result.suspendedState && this.config.stateStore) {
        await this.persistSuspendedState(result.suspendedState);
      }

      return result;
    } finally {
      await lock?.release();
    }
  }

  /**
   * Returns a workflow instance that auto-persists on suspend and auto-loads on resume
   * using the given store.
   */
  suspendTo(
    store: WorkflowStateStore,
    options?: { saveMeta?: SaveMeta; lockTtlMs?: number },
  ): DAGWorkflow {
    return new DAGWorkflow({
      ...this.config,
      steps: this.config.steps,
      stateStore: store,
      saveMeta: options?.saveMeta ?? this.config.saveMeta,
      lockTtlMs: options?.lockTtlMs ?? this.config.lockTtlMs,
    });
  }

  /** Validate workflow graph structure. */
  validate(): void {
    validateDagSteps(this.config.steps);
  }

  private getLockTtlMs(): number {
    return this.config.lockTtlMs ?? 60_000;
  }

  private async persistSuspendedState(state: SuspendedWorkflowState): Promise<void> {
    const store = this.config.stateStore;
    if (!store) {
      return;
    }

    const lock = await store.acquireLock?.(state.workflowId, this.getLockTtlMs());
    if (store.acquireLock && !lock) {
      throw new WorkflowStateLockError(
        state.workflowId,
        `Could not acquire lock while persisting workflow "${state.workflowId}"`,
      );
    }

    try {
      await store.save(state.workflowId, state, this.config.saveMeta);
    } finally {
      await lock?.release();
    }
  }

  private async finalizeApprovalOutcome(
    outcome: ApprovalResumeOutcome,
    previousStepId: string,
    workflowId: string,
    lock: LockHandle | null,
  ): Promise<DAGResult | null> {
    if (outcome.kind === 'complete') {
      return null;
    }

    try {
      if (outcome.state.currentStepId !== previousStepId) {
        const existing = getRunContext();
        const result = await runWith(
          {
            ...existing,
            runId: (existing?.runId as string | undefined) ?? workflowId,
          },
          () => this.execute(snapshotFromSuspendedState(outcome.state, [...this.steps.keys()])),
        );

        if (result.status === 'suspended' && result.suspendedState && this.config.stateStore) {
          await this.persistSuspendedState(result.suspendedState);
        } else if (result.status === 'completed' && this.config.stateStore) {
          await this.config.stateStore.delete(workflowId);
        }

        return result;
      }

      const result: DAGResult = {
        status: 'suspended',
        outputs: { ...outcome.state.completedSteps },
        finalOutput: undefined,
        duration: 0,
        stepDurations: { ...outcome.state.stepDurations },
        skippedSteps: [...outcome.state.skippedSteps],
        failedSteps: [],
        suspendedState: outcome.state,
        suspensionMessage: outcome.suspensionMessage ?? outcome.state.suspensionMessage,
      };

      if (this.config.stateStore && outcome.state) {
        await this.persistSuspendedState(outcome.state);
      }

      return result;
    } finally {
      await lock?.release();
    }
  }

  private async acquireResumeLock(workflowId: string): Promise<LockHandle | null> {
    const store = this.config.stateStore;
    if (!store?.acquireLock) {
      return null;
    }
    return store.acquireLock(workflowId, this.getLockTtlMs());
  }

  private async execute(snapshot: ExecutionSnapshot): Promise<DAGResult> {
    const started = Date.now();
    this.cancelled = false;
    this.workflowAbortController = new AbortController();
    this.activeControllers.clear();

    const { statuses, outputs, stepDurations, skippedSteps, failedSteps, workflowInput, workflowId, metadata } =
      snapshot;

    let pendingCount = [...statuses.entries()].filter(([, status]) => status === 'pending').length;
    const maxConcurrency =
      this.config.maxConcurrency === undefined ? Infinity : this.config.maxConcurrency;
    let runningCount = 0;
    let cancellationError: DAGWorkflowCancelledError | undefined;
    let suspendedState: SuspendedWorkflowState | undefined;

    const waiters: Array<() => void> = [];
    const notify = (): void => {
      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    };
    const waitForProgress = (): Promise<void> =>
      new Promise((resolve) => {
        waiters.push(resolve);
      });

    const isDependencyResolved = (depId: string): boolean => {
      const status = statuses.get(depId);
      return status === 'completed' || status === 'skipped' || status === 'failed';
    };

    const getDepOutputs = (step: DAGStep): Record<string, unknown> => {
      const depOutputs: Record<string, unknown> = {};
      for (const depId of step.dependencies ?? []) {
        if (statuses.get(depId) === 'completed') {
          depOutputs[depId] = outputs.get(depId);
        } else {
          depOutputs[depId] = undefined;
        }
      }
      return depOutputs;
    };

    const hasFailedDependency = (step: DAGStep): boolean =>
      (step.dependencies ?? []).some((depId) => statuses.get(depId) === 'failed');

    const cascadeFailure = (stepId: string): void => {
      const queue = [stepId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const dependentId of this.dependents.get(current) ?? []) {
          if (statuses.get(dependentId) !== 'pending') {
            continue;
          }
          statuses.set(dependentId, 'failed');
          failedSteps.push(dependentId);
          pendingCount -= 1;
          queue.push(dependentId);
        }
      }
    };

    const resolveStep = (stepId: string, status: DAGStepStatus, output?: unknown): void => {
      statuses.set(stepId, status);
      if (status === 'completed') {
        outputs.set(stepId, output);
      }
      pendingCount -= 1;
      runningCount -= 1;
      notify();
    };

    const trySuspendAtReadyStep = async (): Promise<boolean> => {
      if (runningCount > 0 || suspendedState) {
        return false;
      }

      for (const stepId of this.topologicalOrder) {
        if (statuses.get(stepId) !== 'pending') {
          continue;
        }

        const step = this.steps.get(stepId)!;
        const deps = step.dependencies ?? [];
        if (!deps.every(isDependencyResolved) || hasFailedDependency(step) || !step.suspend) {
          continue;
        }

        const depOutputs = getDepOutputs(step);
        if (step.condition && !step.condition(depOutputs)) {
          statuses.set(stepId, 'skipped');
          skippedSteps.push(stepId);
          stepDurations.set(stepId, 0);
          pendingCount -= 1;
          continue;
        }

        const pendingStepInput = mapStepInput(step, workflowInput, depOutputs);
        let nextSuspendedState: SuspendedWorkflowState = {
          workflowId,
          stepIds: [...this.steps.keys()],
          completedSteps: Object.fromEntries(outputs),
          skippedSteps: [...skippedSteps],
          stepDurations: Object.fromEntries(stepDurations),
          currentStepId: step.id,
          suspendedAt: Date.now(),
          workflowInput,
          pendingStepInput,
          suspensionMessage: `Waiting for human input at step "${step.name}"`,
          metadata: { ...metadata },
        };

        if (step.approvalGate) {
          const approvalStore = resolveApprovalStore(this.config.approvalStore, step.approvalGate);
          nextSuspendedState = await dispatchApprovalGate({
            gate: step.approvalGate,
            store: approvalStore,
            workflowId,
            stepId: step.id,
            payload: pendingStepInput,
            suspendedState: nextSuspendedState,
            signerSecret: this.config.approvalSignerSecret,
          });
        }

        suspendedState = nextSuspendedState;
        emitAuditEvent({
          type: 'workflow.suspend',
          actor: { type: 'system', id: 'workflow', name: 'workflow' },
          action: 'suspend',
          resource: `workflow:${workflowId}/step:${step.id}`,
          outcome: 'success',
          payload: { suspensionMessage: nextSuspendedState.suspensionMessage },
        });
        notify();
        return true;
      }

      return false;
    };

    const scheduleReadySteps = async (): Promise<void> => {
      if (await trySuspendAtReadyStep()) {
        return;
      }

      for (const stepId of this.topologicalOrder) {
        if (runningCount >= maxConcurrency || suspendedState) {
          break;
        }
        if (statuses.get(stepId) !== 'pending') {
          continue;
        }

        const step = this.steps.get(stepId)!;
        if (step.suspend) {
          continue;
        }

        const deps = step.dependencies ?? [];
        if (!deps.every(isDependencyResolved)) {
          continue;
        }

        if (hasFailedDependency(step)) {
          statuses.set(stepId, 'failed');
          failedSteps.push(stepId);
          pendingCount -= 1;
          cascadeFailure(stepId);
          continue;
        }

        runningCount += 1;
        statuses.set(stepId, 'running');

        void this.runStep(step, workflowInput, getDepOutputs(step))
          .then(({ status, output, duration }) => {
            stepDurations.set(stepId, duration);
            if (status === 'completed') {
              void this.config.onStepComplete?.(stepId, output, duration);
            }
            resolveStep(stepId, status, output);
            if (status === 'failed') {
              failedSteps.push(stepId);
              cascadeFailure(stepId);
            } else if (status === 'skipped') {
              skippedSteps.push(stepId);
            }
          })
          .catch((error: unknown) => {
            if (error instanceof DAGWorkflowCancelledError) {
              cancellationError = error;
              runningCount -= 1;
              notify();
              return;
            }
            const err = error instanceof Error ? error : new Error(String(error));
            stepDurations.set(stepId, 0);
            void this.config.onStepError?.(stepId, err);
            resolveStep(stepId, 'failed');
            failedSteps.push(stepId);
            cascadeFailure(stepId);
          });
      }
    };

    while (pendingCount > 0 && !suspendedState) {
      if (cancellationError) {
        throw cancellationError;
      }

      if (this.cancelled) {
        for (const [stepId, status] of statuses) {
          if (status === 'pending') {
            statuses.set(stepId, 'failed');
            failedSteps.push(stepId);
            pendingCount -= 1;
          }
        }
        throw new DAGWorkflowCancelledError();
      }

      await scheduleReadySteps();

      if (suspendedState) {
        break;
      }

      if (runningCount === 0 && pendingCount > 0) {
        if (await trySuspendAtReadyStep()) {
          break;
        }
        throw new Error('Workflow deadlock: pending steps with no runnable steps');
      }

      if (pendingCount > 0) {
        await waitForProgress();
      }
    }

    const duration = Date.now() - started;

    if (suspendedState) {
      return {
        status: 'suspended',
        outputs: Object.fromEntries(outputs),
        finalOutput: undefined,
        duration,
        stepDurations: Object.fromEntries(stepDurations),
        skippedSteps: [...skippedSteps],
        failedSteps: [...failedSteps],
        suspendedState,
        suspensionMessage: suspendedState.suspensionMessage,
      };
    }

    const terminalStepIds = findTerminalStepIds(this.config.steps);
    const finalOutput = buildFinalOutput(terminalStepIds, outputs);

    return {
      status: failedSteps.length > 0 ? 'failed' : 'completed',
      outputs: Object.fromEntries(outputs),
      finalOutput,
      duration,
      stepDurations: Object.fromEntries(stepDurations),
      skippedSteps: [...skippedSteps],
      failedSteps: [...failedSteps],
    };
  }

  private async runStep(
    step: DAGStep,
    workflowInput: unknown,
    depOutputs: Record<string, unknown>,
  ): Promise<{ status: DAGStepStatus; output?: unknown; duration: number }> {
    const started = Date.now();
    const workflowId = getRunContext()?.runId ?? 'unknown';
    const resource = `workflow:${workflowId}/step:${step.id}`;

    if (this.cancelled || this.workflowAbortController.signal.aborted) {
      throw new DAGWorkflowCancelledError();
    }

    if (step.condition && !step.condition(depOutputs)) {
      emitAuditEvent({
        type: 'workflow.step.end',
        actor: { type: 'system', id: 'workflow', name: 'workflow' },
        action: 'step',
        resource,
        outcome: 'skipped',
        duration: Date.now() - started,
      });
      return { status: 'skipped', duration: Date.now() - started };
    }

    emitAuditEvent({
      type: 'workflow.step.start',
      actor: { type: 'system', id: 'workflow', name: 'workflow' },
      action: 'step',
      resource,
      outcome: 'success',
    });

    const retries = step.retries ?? 0;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (this.cancelled) {
        throw new DAGWorkflowCancelledError();
      }

      const controller = new AbortController();
      this.activeControllers.add(controller);

      const abortFromWorkflow = (): void => controller.abort();
      this.workflowAbortController.signal.addEventListener('abort', abortFromWorkflow);

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (step.timeout !== undefined) {
        timeoutId = setTimeout(() => controller.abort(), step.timeout);
        timeoutId.unref?.();
      }

      const mappedInput = mapStepInput(step, workflowInput, depOutputs);

      try {
        const output = await runWith(withStep(step.id), async () => {
          const context: StepContext = {
            workflowInput,
            stepId: step.id,
            attempt,
            signal: controller.signal,
            runContext: getRunContext(),
          };
          return executeWithAbort(
            step.execute.bind(step),
            mappedInput,
            context,
            DAGWorkflowCancelledError,
          );
        });
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.workflowAbortController.signal.removeEventListener('abort', abortFromWorkflow);
        this.activeControllers.delete(controller);
        emitAuditEvent({
          type: 'workflow.step.end',
          actor: { type: 'system', id: 'workflow', name: 'workflow' },
          action: 'step',
          resource,
          outcome: 'success',
          duration: Date.now() - started,
        });
        return { status: 'completed', output, duration: Date.now() - started };
      } catch (error) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.workflowAbortController.signal.removeEventListener('abort', abortFromWorkflow);
        this.activeControllers.delete(controller);

        if (this.cancelled || error instanceof DAGWorkflowCancelledError) {
          throw new DAGWorkflowCancelledError();
        }

        if (controller.signal.aborted && step.timeout !== undefined) {
          lastError = new DAGStepTimeoutError(step.id, step.timeout);
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }

        if (attempt < retries) {
          continue;
        }
      }
    }

    if (lastError) {
      void this.config.onStepError?.(step.id, lastError);
      emitAuditEvent({
        type: 'workflow.step.end',
        actor: { type: 'system', id: 'workflow', name: 'workflow' },
        action: 'step',
        resource,
        outcome: 'failure',
        duration: Date.now() - started,
        payload: { error: lastError.message },
      });
      return { status: 'failed', duration: Date.now() - started };
    }

    emitAuditEvent({
      type: 'workflow.step.end',
      actor: { type: 'system', id: 'workflow', name: 'workflow' },
      action: 'step',
      resource,
      outcome: 'failure',
      duration: Date.now() - started,
    });
    return { status: 'failed', duration: Date.now() - started };
  }
}

/** Fluent builder for {@link DAGWorkflow}. */
export class DAGBuilder {
  private readonly steps: DAGStep[] = [];

  /** Register a step in the workflow graph. */
  addStep<TInput = unknown, TOutput = unknown>(
    id: string,
    step: Omit<DAGStep<TInput, TOutput>, 'id'>,
  ): this {
    this.steps.push({ id, ...step } as DAGStep);
    return this;
  }

  /** Build a validated {@link DAGWorkflow}. */
  build(options?: Omit<DAGWorkflowConfig, 'steps'>): DAGWorkflow {
    return new DAGWorkflow({ steps: [...this.steps], ...options });
  }
}

/** Create a {@link DAGStep} that runs {@link Agent.run}. */
export function agentStep(
  agent: Agent,
  options: Omit<DAGStep<string, AgentResult>, 'id' | 'name' | 'execute'> & {
    id?: string;
    name?: string;
  } = {},
): DAGStep<string, AgentResult> {
  const { id = agent.getName(), name = agent.getName(), ...rest } = options;

  return {
    id,
    name,
    ...rest,
    execute: async (input, context) => {
      throwIfAborted(context.signal, DAGWorkflowCancelledError);
      const textInput = typeof input === 'string' ? input : JSON.stringify(input);
      return agent.run(textInput);
    },
  };
}

/** Create a {@link DAGStep} from an async function. */
export function functionStep<TInput = unknown, TOutput = unknown>(
  id: string,
  name: string,
  fn: (input: TInput, context: StepContext) => Promise<TOutput>,
  options: Omit<DAGStep<TInput, TOutput>, 'id' | 'name' | 'execute'> = {},
): DAGStep<TInput, TOutput> {
  return {
    id,
    name,
    ...options,
    execute: fn,
  };
}

/** Internal sub-step executed by {@link parallelStep}. */
export interface ParallelSubStep<TInput = unknown, TOutput = unknown> {
  id: string;
  execute: (input: TInput, context: StepContext) => Promise<TOutput>;
}

/** Create a {@link DAGStep} that runs sub-steps concurrently. */
export function parallelStep<TInput = unknown>(
  id: string,
  name: string,
  subSteps: ParallelSubStep<TInput>[],
  options: Omit<DAGStep<TInput, Record<string, unknown>>, 'id' | 'name' | 'execute'> = {},
): DAGStep<TInput, Record<string, unknown>> {
  return {
    id,
    name,
    ...options,
    execute: async (input, context) => {
      throwIfAborted(context.signal, DAGWorkflowCancelledError);
      const results = await Promise.all(
        subSteps.map(async (subStep) =>
          runWith(withStep(subStep.id), async () => {
            const subContext: StepContext = {
              ...context,
              stepId: subStep.id,
              runContext: getRunContext(),
            };
            return subStep.execute(input, subContext);
          }),
        ),
      );
      return Object.fromEntries(subSteps.map((subStep, index) => [subStep.id, results[index]]));
    },
  };
}

function createInitialSnapshot(workflowId: string, workflowInput: unknown, stepIds: string[]): ExecutionSnapshot {
  const statuses = new Map<string, DAGStepStatus>(stepIds.map((id) => [id, 'pending']));
  return {
    workflowId,
    workflowInput,
    metadata: {},
    statuses,
    outputs: new Map<string, unknown>(),
    stepDurations: new Map<string, number>(),
    skippedSteps: [],
    failedSteps: [],
  };
}

function snapshotFromSuspendedState(
  state: SuspendedWorkflowState,
  allStepIds: string[],
): ExecutionSnapshot {
  const statuses = new Map<string, DAGStepStatus>();
  const outputs = new Map<string, unknown>(Object.entries(state.completedSteps));
  const stepDurations = new Map<string, number>(Object.entries(state.stepDurations));
  const skippedSteps = [...state.skippedSteps];

  for (const stepId of allStepIds) {
    if (outputs.has(stepId)) {
      statuses.set(stepId, 'completed');
    } else if (skippedSteps.includes(stepId)) {
      statuses.set(stepId, 'skipped');
    } else {
      statuses.set(stepId, 'pending');
    }
  }

  return {
    workflowId: state.workflowId,
    workflowInput: state.workflowInput,
    metadata: { ...state.metadata },
    statuses,
    outputs,
    stepDurations,
    skippedSteps,
    failedSteps: [],
  };
}

function rehydrateSnapshot(
  state: SuspendedWorkflowState,
  input: ResumeInput,
  allStepIds: string[],
): ExecutionSnapshot {
  const statuses = new Map<string, DAGStepStatus>();
  const outputs = new Map<string, unknown>(Object.entries(state.completedSteps));
  const stepDurations = new Map<string, number>(Object.entries(state.stepDurations));
  const skippedSteps = [...state.skippedSteps];
  const failedSteps: string[] = [];

  for (const stepId of allStepIds) {
    if (outputs.has(stepId)) {
      statuses.set(stepId, 'completed');
    } else if (skippedSteps.includes(stepId)) {
      statuses.set(stepId, 'skipped');
    } else {
      statuses.set(stepId, 'pending');
    }
  }

  statuses.set(state.currentStepId, 'completed');
  outputs.set(state.currentStepId, input.stepOutput);
  stepDurations.set(state.currentStepId, 0);

  return {
    workflowId: state.workflowId,
    workflowInput: state.workflowInput,
    metadata: { ...state.metadata, ...input.metadata },
    statuses,
    outputs,
    stepDurations,
    skippedSteps,
    failedSteps,
  };
}

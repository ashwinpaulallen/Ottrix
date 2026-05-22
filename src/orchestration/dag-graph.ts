import type { DAGStep } from './dag-types.js';
import { CyclicDependencyError } from './dag-types.js';

/** Build a map of step ID → dependent step IDs. */
export function buildDependentsMap(steps: DAGStep[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const depId of step.dependencies ?? []) {
      const list = dependents.get(depId) ?? [];
      list.push(step.id);
      dependents.set(depId, list);
    }
  }
  return dependents;
}

/** Return step IDs that no other step depends on. */
export function findTerminalStepIds(steps: DAGStep[]): string[] {
  const dependedOn = new Set<string>();
  for (const step of steps) {
    for (const depId of step.dependencies ?? []) {
      dependedOn.add(depId);
    }
  }
  return steps.filter((step) => !dependedOn.has(step.id)).map((step) => step.id);
}

/** Topological order of step IDs; throws {@link CyclicDependencyError} on cycles. */
export function topologicalSort(steps: DAGStep[]): string[] {
  const ids = steps.map((step) => step.id);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const step of steps) {
    for (const depId of step.dependencies ?? []) {
      adjacency.get(depId)?.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const next of adjacency.get(current) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
      }
    }
  }

  if (sorted.length !== steps.length) {
    throw new CyclicDependencyError();
  }

  return sorted;
}

/** Validate a workflow graph and return its topological execution order. */
export function validateDagSteps(steps: DAGStep[]): string[] {
  if (steps.length === 0) {
    throw new Error('DAGWorkflow requires at least one step');
  }

  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    throw new Error('DAGWorkflow step IDs must be unique');
  }

  for (const step of steps) {
    for (const depId of step.dependencies ?? []) {
      if (!ids.has(depId)) {
        throw new Error(`Step "${step.id}" depends on unknown step "${depId}"`);
      }
    }
  }

  const order = topologicalSort(steps);

  const roots = steps.filter((step) => (step.dependencies?.length ?? 0) === 0);
  if (roots.length === 0) {
    throw new Error('DAGWorkflow requires at least one root step with no dependencies');
  }

  const terminalIds = findTerminalStepIds(steps);
  if (terminalIds.length === 0) {
    throw new Error('DAGWorkflow requires at least one terminal step');
  }

  return order;
}

/** Merge terminal step outputs into a single workflow result value. */
export function buildFinalOutput(
  terminalStepIds: string[],
  outputs: Map<string, unknown>,
): unknown {
  if (terminalStepIds.length === 1) {
    return outputs.get(terminalStepIds[0]!);
  }

  const merged: Record<string, unknown> = {};
  for (const stepId of terminalStepIds) {
    if (outputs.has(stepId)) {
      merged[stepId] = outputs.get(stepId);
    }
  }
  return merged;
}

/** Map dependency outputs (or workflow input for roots) to a step input value. */
export function mapStepInput(
  step: DAGStep,
  workflowInput: unknown,
  depOutputs: Record<string, unknown>,
): unknown {
  if ((step.dependencies?.length ?? 0) === 0) {
    return workflowInput;
  }
  return step.inputMapper ? step.inputMapper(depOutputs) : depOutputs;
}

/** Throw when an {@link AbortSignal} has fired. */
export function throwIfAborted(
  signal: AbortSignal,
  ErrorType: new (message?: string) => Error = Error,
): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new ErrorType();
  }
}

/** Run a step execute function, rejecting when the abort signal fires. */
export function executeWithAbort<TInput>(
  execute: (input: TInput, context: import('./dag-types.js').StepContext) => Promise<unknown>,
  input: TInput,
  context: import('./dag-types.js').StepContext,
  CancelError: new (message?: string) => Error,
): Promise<unknown> {
  throwIfAborted(context.signal, CancelError);

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        context.signal.reason instanceof Error ? context.signal.reason : new CancelError(),
      );
    };

    if (context.signal.aborted) {
      onAbort();
      return;
    }

    context.signal.addEventListener('abort', onAbort, { once: true });

    execute(input, context)
      .then((value) => {
        context.signal.removeEventListener('abort', onAbort);
        if (context.signal.aborted) {
          onAbort();
          return;
        }
        resolve(value);
      })
      .catch((error: unknown) => {
        context.signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

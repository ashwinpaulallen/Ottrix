import type { SuspendedWorkflowState } from './dag-types.js';

/** Persistence layer for {@link SuspendedWorkflowState} between suspend and resume. */
export interface WorkflowStateStore {
  /** Persist a suspended workflow state. */
  save(state: SuspendedWorkflowState): Promise<void>;
  /** Load a suspended workflow by ID, or null if not found. */
  load(workflowId: string): Promise<SuspendedWorkflowState | null>;
  /** Remove a suspended workflow state. */
  delete(workflowId: string): Promise<void>;
  /** List all suspended workflow states. */
  list(): Promise<SuspendedWorkflowState[]>;
}

/** In-memory {@link WorkflowStateStore} backed by a Map. */
export class InMemoryStateStore implements WorkflowStateStore {
  private readonly states = new Map<string, SuspendedWorkflowState>();

  async save(state: SuspendedWorkflowState): Promise<void> {
    this.states.set(state.workflowId, cloneState(state));
  }

  async load(workflowId: string): Promise<SuspendedWorkflowState | null> {
    const state = this.states.get(workflowId);
    return state ? cloneState(state) : null;
  }

  async delete(workflowId: string): Promise<void> {
    this.states.delete(workflowId);
  }

  async list(): Promise<SuspendedWorkflowState[]> {
    return [...this.states.values()].map(cloneState);
  }
}

function cloneState(state: SuspendedWorkflowState): SuspendedWorkflowState {
  return structuredClone(state);
}

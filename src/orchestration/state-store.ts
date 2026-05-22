import type { SuspendedWorkflowState } from './dag-types.js';

/** Metadata persisted alongside a suspended workflow state. */
export interface SaveMeta {
  /** Why the workflow suspended (approval, human input, external wait). */
  reason?: string;
  /** Auto-expire the suspended state after this duration in milliseconds. */
  ttlMs?: number;
  /** Tags for filtering (e.g. orgId, agentName). */
  tags?: Record<string, string>;
}

/** Filter options for {@link WorkflowStateStore.list}. */
export interface ListFilter {
  tags?: Record<string, string>;
  status?: 'suspended' | 'expired' | 'all';
  limit?: number;
  offset?: number;
  orderBy?: 'suspendedAt' | 'ttlExpiry';
}

/** Summary of a suspended workflow run returned by {@link WorkflowStateStore.list}. */
export interface SuspendedRunInfo {
  workflowId: string;
  suspendedAt: number;
  currentStepId: string;
  reason?: string;
  tags?: Record<string, string>;
  ttlExpiry?: number;
}

/** Handle returned by {@link WorkflowStateStore.acquireLock}. */
export interface LockHandle {
  release(): Promise<void>;
  extend(ttlMs: number): Promise<void>;
}

/**
 * Pluggable persistence for {@link SuspendedWorkflowState} between suspend and resume.
 */
export interface WorkflowStateStore {
  save(workflowId: string, state: SuspendedWorkflowState, meta?: SaveMeta): Promise<void>;
  load(workflowId: string): Promise<SuspendedWorkflowState | null>;
  list(filter?: ListFilter): Promise<SuspendedRunInfo[]>;
  delete(workflowId: string): Promise<void>;
  acquireLock?(workflowId: string, ttlMs: number): Promise<LockHandle | null>;
}

/** Thrown when a workflow resume lock cannot be acquired. */
export class WorkflowStateLockError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string, message?: string) {
    super(message ?? `Could not acquire lock for workflow "${workflowId}"`);
    this.name = 'WorkflowStateLockError';
    this.workflowId = workflowId;
  }
}

/** Thrown when importing optional peer dependencies for state store adapters. */
export class StateStorePeerDependencyError extends Error {
  constructor(packageName: string) {
    super(
      `${packageName} is required for this state store adapter. ` +
        `Install it with: npm install ${packageName}`,
    );
    this.name = 'StateStorePeerDependencyError';
  }
}

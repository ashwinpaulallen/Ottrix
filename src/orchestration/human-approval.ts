import type { ZodType } from 'zod';

import { DecisionSigner } from './decision-signer.js';
import type { DAGStep } from './dag-types.js';
import type { ResumeInput, SuspendedWorkflowState } from './dag-types.js';

/** Metadata key stored in {@link SuspendedWorkflowState.metadata}. */
export const APPROVAL_METADATA_KEY = 'ottrixApproval';

/** Configuration for a human approval gate step. */
export interface ApprovalGateConfig {
  /** Required approver role. */
  role?: string;
  /** Number of approvals required. @defaultValue 1 */
  multi?: number;
  /** Approval window in seconds. @defaultValue 86400 (24h) */
  timeoutSec?: number;
  /** Action when the approval window expires. */
  onTimeout: 'escalate' | 'reject' | 'auto-approve';
  /** Optional Zod schema for validating decision payloads. */
  schema?: ZodType;
  /** Optional custom signature function for audit trails. */
  sign?: (decision: ApprovalDecision, signer: DecisionSigner) => string;
  /** How approvers are notified. */
  dispatcher?: ApprovalDispatcher;
  /** Approval audit store; falls back to {@link DAGWorkflowConfig.approvalStore}. */
  store?: ApprovalStore;
  /** Roles to escalate through when `onTimeout` is `'escalate'`. */
  escalationRoles?: string[];
  /** When true, all approvers must reject before the gate rejects. @defaultValue false */
  requireUnanimousReject?: boolean;
  /** How redirect edits are applied. @defaultValue 'downstream' */
  redirectMode?: 'upstream' | 'downstream';
  /** URL included in approval requests for webhook-based resume. */
  resumeUrl?: string;
  /** Human-readable step name override. */
  name?: string;
}

/** A signed or unsigned human approval decision. */
export interface ApprovalDecision {
  action: 'approve' | 'reject' | 'redirect';
  approver: { id: string; role: string; name?: string };
  reason?: string;
  edits?: Record<string, unknown>;
  timestamp: number;
  signature?: string;
}

/** Notifies humans that an approval is required. */
export interface ApprovalDispatcher {
  notify(request: ApprovalRequest): Promise<void>;
}

/** Approval notification dispatched to humans. */
export interface ApprovalRequest {
  workflowId: string;
  stepId: string;
  role: string;
  payload: unknown;
  resumeUrl?: string;
  expiresAt: number;
  requiredApprovals?: number;
}

/** Persistent audit store for approval requests and decisions. */
export interface ApprovalStore {
  createRequest(req: ApprovalRequest): Promise<void>;
  recordDecision(workflowId: string, stepId: string, decision: ApprovalDecision): Promise<void>;
  getDecisions(workflowId: string, stepId: string): Promise<ApprovalDecision[]>;
  getPendingRequests(filter?: { role?: string }): Promise<ApprovalRequest[]>;
}

/** Final output produced by an approval gate step. */
export interface ApprovalGateResult {
  status: 'approved' | 'rejected';
  decisions: ApprovalDecision[];
  payload: unknown;
}

/** Serializable approval state stored in suspended workflow metadata. */
export interface ApprovalStateMetadata {
  role: string;
  expiresAt: number;
  escalationIndex: number;
  payload: unknown;
  requiredApprovals: number;
  resumeUrl?: string;
  gateStepId: string;
  upstreamStepId?: string;
}

export type ApprovalResumeOutcome =
  | { kind: 'suspend'; state: SuspendedWorkflowState; suspensionMessage?: string }
  | { kind: 'complete'; output: ApprovalGateResult };

/** In-memory {@link ApprovalStore} for development and tests. */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly decisions = new Map<string, ApprovalDecision[]>();

  createRequest(req: ApprovalRequest): Promise<void> {
    this.requests.set(requestKey(req.workflowId, req.stepId), { ...req });
    return Promise.resolve();
  }

  recordDecision(
    workflowId: string,
    stepId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const key = requestKey(workflowId, stepId);
    const existing = this.decisions.get(key) ?? [];
    existing.push(structuredClone(decision));
    this.decisions.set(key, existing);
    return Promise.resolve();
  }

  getDecisions(workflowId: string, stepId: string): Promise<ApprovalDecision[]> {
    return Promise.resolve(structuredClone(this.decisions.get(requestKey(workflowId, stepId)) ?? []));
  }

  getPendingRequests(filter: { role?: string } = {}): Promise<ApprovalRequest[]> {
    const pending: ApprovalRequest[] = [];

    for (const [key, request] of this.requests) {
      const decisions = this.decisions.get(key) ?? [];
      const required = request.requiredApprovals ?? 1;
      const approvals = decisions.filter((entry) => entry.action === 'approve').length;
      const rejected = decisions.some((entry) => entry.action === 'reject');

      if (rejected || approvals >= required) {
        continue;
      }
      if (filter.role && request.role !== filter.role) {
        continue;
      }
      pending.push({ ...request });
    }

    return Promise.resolve(pending);
  }
}

/** Creates a {@link DAGStep} that suspends for human approval. */
export function humanApproval(config: ApprovalGateConfig): Omit<DAGStep, 'id'> {
  return {
    name: config.name ?? (config.role ? `Approval (${config.role})` : 'Human Approval'),
    suspend: true,
    approvalGate: config,
    execute: (input) => Promise.resolve(input),
  };
}

/** Returns true when a value is an {@link ApprovalDecision}. */
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const decision = value as ApprovalDecision;
  return (
    (decision.action === 'approve' ||
      decision.action === 'reject' ||
      decision.action === 'redirect') &&
    typeof decision.timestamp === 'number' &&
    typeof decision.approver?.id === 'string' &&
    typeof decision.approver?.role === 'string'
  );
}

export interface DispatchApprovalGateOptions {
  gate: ApprovalGateConfig;
  store: ApprovalStore;
  workflowId: string;
  stepId: string;
  payload: unknown;
  suspendedState: SuspendedWorkflowState;
  signerSecret?: string;
}

/** Dispatch an approval request when a gate step suspends. */
export async function dispatchApprovalGate(
  options: DispatchApprovalGateOptions,
): Promise<SuspendedWorkflowState> {
  const { gate, store, workflowId, stepId, payload } = options;
  const timeoutSec = gate.timeoutSec ?? 86_400;
  const role = gate.role ?? 'approver';
  const expiresAt = Date.now() + timeoutSec * 1_000;

  const request: ApprovalRequest = {
    workflowId,
    stepId,
    role,
    payload,
    resumeUrl: gate.resumeUrl,
    expiresAt,
    requiredApprovals: gate.multi ?? 1,
  };

  await store.createRequest(request);
  await gate.dispatcher?.notify(request);

  const approvalMetadata: ApprovalStateMetadata = {
    role,
    expiresAt,
    escalationIndex: 0,
    payload,
    requiredApprovals: gate.multi ?? 1,
    resumeUrl: gate.resumeUrl,
    gateStepId: stepId,
  };

  return {
    ...options.suspendedState,
    suspensionMessage: `Waiting for approval from ${role}`,
    metadata: {
      ...options.suspendedState.metadata,
      [APPROVAL_METADATA_KEY]: approvalMetadata,
    },
  };
}

export interface HandleApprovalResumeOptions {
  gate: ApprovalGateConfig;
  store: ApprovalStore;
  state: SuspendedWorkflowState;
  resumeInput: ResumeInput;
  upstreamStepId?: string;
  signerSecret?: string;
}

/** Process a resume call for an approval gate step. */
export async function handleApprovalResume(
  options: HandleApprovalResumeOptions,
): Promise<ApprovalResumeOutcome> {
  const { gate, store, state, resumeInput, upstreamStepId } = options;
  const metadata = getApprovalMetadata(state);
  if (!metadata) {
    throw new Error(`Missing approval metadata for workflow "${state.workflowId}"`);
  }

  if (Date.now() > metadata.expiresAt) {
    return handleApprovalTimeout(options, metadata);
  }

  if (!isApprovalDecision(resumeInput.stepOutput)) {
    throw new Error('Approval gate resume requires an ApprovalDecision as stepOutput');
  }

  const decision = structuredClone(resumeInput.stepOutput);
  validateDecisionSchema(gate, decision);

  if (gate.sign) {
    const signer = new DecisionSigner(options.signerSecret ?? 'ottrix-approval-secret');
    decision.signature = gate.sign(decision, signer);
  }

  await store.recordDecision(state.workflowId, metadata.gateStepId, decision);

  if (decision.action === 'redirect') {
    return handleRedirect(options, metadata, decision, upstreamStepId);
  }

  const decisions = await store.getDecisions(state.workflowId, metadata.gateStepId);
  const rejectOutcome = evaluateRejections(gate, metadata, decisions);
  if (rejectOutcome) {
    return rejectOutcome;
  }

  const approvals = decisions.filter((entry) => entry.action === 'approve');
  if (approvals.length >= metadata.requiredApprovals) {
    return {
      kind: 'complete',
      output: {
        status: 'approved',
        decisions,
        payload: metadata.payload,
      },
    };
  }

  return {
    kind: 'suspend',
    state: {
      ...state,
      suspendedAt: Date.now(),
      suspensionMessage: `Waiting for ${metadata.requiredApprovals - approvals.length} more approval(s) from ${metadata.role}`,
      metadata: {
        ...state.metadata,
        [APPROVAL_METADATA_KEY]: metadata,
      },
    },
    suspensionMessage: `Waiting for ${metadata.requiredApprovals - approvals.length} more approval(s)`,
  };
}

function evaluateRejections(
  gate: ApprovalGateConfig,
  metadata: ApprovalStateMetadata,
  decisions: ApprovalDecision[],
): ApprovalResumeOutcome | null {
  const rejects = decisions.filter((entry) => entry.action === 'reject');
  if (rejects.length === 0) {
    return null;
  }

  const requiredRejects = gate.requireUnanimousReject ? metadata.requiredApprovals : 1;
  if (rejects.length < requiredRejects) {
    return null;
  }

  return {
    kind: 'complete',
    output: {
      status: 'rejected',
      decisions,
      payload: metadata.payload,
    },
  };
}

async function handleRedirect(
  options: HandleApprovalResumeOptions,
  metadata: ApprovalStateMetadata,
  decision: ApprovalDecision,
  upstreamStepId?: string,
): Promise<ApprovalResumeOutcome> {
  const { gate, store, state } = options;
  const edits = decision.edits ?? {};
  const mergedPayload = mergePayload(metadata.payload, edits);
  const redirectMode = gate.redirectMode ?? 'downstream';

  if (redirectMode === 'upstream' && upstreamStepId) {
    const completedSteps = { ...state.completedSteps };
    delete completedSteps[upstreamStepId];

    return {
      kind: 'suspend',
      state: {
        ...state,
        currentStepId: upstreamStepId,
        completedSteps,
        suspendedAt: Date.now(),
        suspensionMessage: `Redirected to upstream step "${upstreamStepId}" for revision`,
        metadata: {
          ...state.metadata,
          redirectEdits: edits,
          [APPROVAL_METADATA_KEY]: undefined,
        },
      },
      suspensionMessage: `Redirected to upstream step "${upstreamStepId}" for revision`,
    };
  }

  const request: ApprovalRequest = {
    workflowId: state.workflowId,
    stepId: metadata.gateStepId,
    role: metadata.role,
    payload: mergedPayload,
    resumeUrl: metadata.resumeUrl,
    expiresAt: metadata.expiresAt,
    requiredApprovals: metadata.requiredApprovals,
  };

  await store.createRequest(request);
  await gate.dispatcher?.notify(request);

  const nextMetadata: ApprovalStateMetadata = {
    ...metadata,
    payload: mergedPayload,
  };

  return {
    kind: 'suspend',
    state: {
      ...state,
      suspendedAt: Date.now(),
      suspensionMessage: `Waiting for re-approval from ${metadata.role} after redirect`,
      metadata: {
        ...state.metadata,
        [APPROVAL_METADATA_KEY]: nextMetadata,
      },
    },
    suspensionMessage: 'Waiting for re-approval after redirect',
  };
}

async function handleApprovalTimeout(
  options: HandleApprovalResumeOptions,
  metadata: ApprovalStateMetadata,
): Promise<ApprovalResumeOutcome> {
  const { gate, store, state } = options;

  switch (gate.onTimeout) {
    case 'reject':
      return {
        kind: 'complete',
        output: {
          status: 'rejected',
          decisions: [],
          payload: metadata.payload,
        },
      };
    case 'auto-approve':
      return {
        kind: 'complete',
        output: {
          status: 'approved',
          decisions: [
            {
              action: 'approve',
              approver: { id: 'system', role: 'system' },
              reason: 'auto-approved on timeout',
              timestamp: Date.now(),
            },
          ],
          payload: metadata.payload,
        },
      };
    case 'escalate': {
      const chain = gate.escalationRoles ?? [];
      const nextIndex = metadata.escalationIndex + 1;
      const nextRole = chain[nextIndex] ?? chain[chain.length - 1];

      if (!nextRole || nextIndex > chain.length) {
        return {
          kind: 'complete',
          output: {
            status: 'rejected',
            decisions: [],
            payload: metadata.payload,
          },
        };
      }

      const timeoutSec = gate.timeoutSec ?? 86_400;
      const expiresAt = Date.now() + timeoutSec * 1_000;
      const request: ApprovalRequest = {
        workflowId: state.workflowId,
        stepId: metadata.gateStepId,
        role: nextRole,
        payload: metadata.payload,
        resumeUrl: metadata.resumeUrl,
        expiresAt,
        requiredApprovals: metadata.requiredApprovals,
      };

      await store.createRequest(request);
      await gate.dispatcher?.notify(request);

      const escalatedMetadata: ApprovalStateMetadata = {
        ...metadata,
        role: nextRole,
        escalationIndex: nextIndex,
        expiresAt,
      };

      return {
        kind: 'suspend',
        state: {
          ...state,
          suspendedAt: Date.now(),
          suspensionMessage: `Approval escalated to ${nextRole}`,
          metadata: {
            ...state.metadata,
            [APPROVAL_METADATA_KEY]: escalatedMetadata,
          },
        },
        suspensionMessage: `Approval escalated to ${nextRole}`,
      };
    }
    default:
      throw new Error(`Unsupported onTimeout action: ${String(gate.onTimeout)}`);
  }
}

export function getApprovalMetadata(state: SuspendedWorkflowState): ApprovalStateMetadata | null {
  const raw = state.metadata?.[APPROVAL_METADATA_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return raw as ApprovalStateMetadata;
}

export function resolveApprovalStore(
  workflowStore: ApprovalStore | undefined,
  gate: ApprovalGateConfig,
): ApprovalStore {
  return gate.store ?? workflowStore ?? new InMemoryApprovalStore();
}

function requestKey(workflowId: string, stepId: string): string {
  return `${workflowId}:${stepId}`;
}

function mergePayload(payload: unknown, edits: Record<string, unknown>): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), ...edits };
  }
  return edits;
}

function validateDecisionSchema(gate: ApprovalGateConfig, decision: ApprovalDecision): void {
  if (!gate.schema) {
    return;
  }
  gate.schema.parse(decision);
}

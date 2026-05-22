import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CallbackDispatcher } from '../../src/orchestration/approval-dispatchers/index.js';
import { WebhookDispatcher } from '../../src/orchestration/approval-dispatchers/index.js';
import { DAGBuilder } from '../../src/orchestration/dag.js';
import { signJwt, verifyJwt } from '../../src/orchestration/decision-signer.js';
import {
  humanApproval,
  InMemoryApprovalStore,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../../src/orchestration/human-approval.js';
import { InMemoryStateStore } from '../../src/orchestration/state-stores/in-memory.js';

function approveDecision(overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    action: 'approve',
    approver: { id: 'user-1', role: 'tech-lead', name: 'Alex' },
    timestamp: Date.now(),
    ...overrides,
  };
}

function rejectDecision(overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    action: 'reject',
    approver: { id: 'user-2', role: 'tech-lead' },
    reason: 'Not ready',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('humanApproval gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suspends the workflow and dispatches an approval request', async () => {
    const store = new InMemoryApprovalStore();
    const dispatched: ApprovalRequest[] = [];
    const dispatcher = new CallbackDispatcher({
      callback: async (request) => {
        dispatched.push(request);
      },
    });

    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({
          role: 'tech-lead',
          onTimeout: 'reject',
          dispatcher,
          store,
        }),
        dependencies: ['design'],
      })
      .build({ approvalStore: store });

    const result = await workflow.run('feature', { workflowId: 'wf-approval-1' });

    expect(result.status).toBe('suspended');
    expect(result.suspendedState?.currentStepId).toBe('gate');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.role).toBe('tech-lead');
    expect(dispatched[0]?.payload).toEqual({ design: { doc: 'design-v1' } });
    expect(await store.getPendingRequests({ role: 'tech-lead' })).toHaveLength(1);
  });

  it('continues the workflow after approval', async () => {
    const store = new InMemoryApprovalStore();
    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({ role: 'tech-lead', onTimeout: 'reject', store }),
        dependencies: ['design'],
      })
      .addStep('implement', {
        name: 'Implement',
        execute: async (input: { gate: { status: string; payload: unknown } }) =>
          `built:${JSON.stringify(input.gate.payload)}`,
        dependencies: ['gate'],
        inputMapper: (deps) => ({ gate: deps.gate }),
        condition: (deps) => (deps.gate as { status: string }).status === 'approved',
      })
      .build({ approvalStore: store });

    const suspended = await workflow.run('feature', { workflowId: 'wf-approve' });
    const completed = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-approve',
      stepOutput: approveDecision(),
    });

    expect(completed.status).toBe('completed');
    expect(completed.outputs.gate).toMatchObject({ status: 'approved' });
    expect(completed.finalOutput).toContain('built:');
  });

  it('marks the gate as rejected and skips downstream work', async () => {
    const store = new InMemoryApprovalStore();
    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({ role: 'tech-lead', onTimeout: 'reject', store }),
        dependencies: ['design'],
      })
      .addStep('implement', {
        name: 'Implement',
        execute: async () => 'should-not-run',
        dependencies: ['gate'],
        condition: (deps) => (deps.gate as { status: string }).status === 'approved',
      })
      .addStep('notify', {
        name: 'Notify Rejection',
        execute: async (input: string) => input,
        dependencies: ['gate'],
        inputMapper: (deps) => (deps.gate as { status: string }).status,
        condition: (deps) => (deps.gate as { status: string }).status === 'rejected',
      })
      .build({ approvalStore: store });

    const suspended = await workflow.run('feature', { workflowId: 'wf-reject' });
    const completed = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-reject',
      stepOutput: rejectDecision(),
    });

    expect(completed.status).toBe('completed');
    expect(completed.outputs.gate).toMatchObject({ status: 'rejected' });
    expect(completed.outputs.implement).toBeUndefined();
    expect(completed.finalOutput).toEqual({ notify: 'rejected' });
  });

  it('re-suspends for re-approval after redirect with downstream edits', async () => {
    const store = new InMemoryApprovalStore();
    const dispatched: ApprovalRequest[] = [];
    const dispatcher = new CallbackDispatcher({
      callback: async (request) => {
        dispatched.push(request);
      },
    });

    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({
          role: 'tech-lead',
          onTimeout: 'reject',
          store,
          dispatcher,
          redirectMode: 'downstream',
        }),
        dependencies: ['design'],
      })
      .addStep('implement', {
        name: 'Implement',
        execute: async (input: { gate: { status: string; payload: { doc: string } } }) =>
          input.gate.payload.doc,
        dependencies: ['gate'],
        inputMapper: (deps) => ({ gate: deps.gate }),
        condition: (deps) => (deps.gate as { status: string }).status === 'approved',
      })
      .build({ approvalStore: store });

    const suspended = await workflow.run('feature', { workflowId: 'wf-redirect' });
    const redirected = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-redirect',
      stepOutput: {
        action: 'redirect',
        approver: { id: 'lead-1', role: 'tech-lead' },
        edits: { doc: 'design-v2' },
        timestamp: Date.now(),
      },
    });

    expect(redirected.status).toBe('suspended');
    expect(redirected.suspendedState?.currentStepId).toBe('gate');
    expect(dispatched).toHaveLength(2);

    const completed = await workflow.resume(redirected.suspendedState!, {
      workflowId: 'wf-redirect',
      stepOutput: approveDecision({ approver: { id: 'lead-2', role: 'tech-lead' } }),
    });

    expect(completed.status).toBe('completed');
    expect(completed.finalOutput).toBe('design-v2');
  });

  it('collects multiple approvals before continuing', async () => {
    const store = new InMemoryApprovalStore();
    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({ role: 'reviewer', multi: 2, onTimeout: 'reject', store }),
        dependencies: ['design'],
      })
      .addStep('implement', {
        name: 'Implement',
        execute: async () => 'done',
        dependencies: ['gate'],
        condition: (deps) => (deps.gate as { status: string }).status === 'approved',
      })
      .build({ approvalStore: store });

    const suspended = await workflow.run('feature', { workflowId: 'wf-multi' });
    const partial = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-multi',
      stepOutput: approveDecision({ approver: { id: 'rev-1', role: 'reviewer' } }),
    });

    expect(partial.status).toBe('suspended');
    expect(partial.suspensionMessage).toContain('1 more approval');

    const completed = await workflow.resume(partial.suspendedState!, {
      workflowId: 'wf-multi',
      stepOutput: approveDecision({ approver: { id: 'rev-2', role: 'reviewer' } }),
    });

    expect(completed.status).toBe('completed');
    expect((completed.outputs.gate as { decisions: ApprovalDecision[] }).decisions).toHaveLength(2);
  });

  it('executes onTimeout when approval expires on resume', async () => {
    vi.useFakeTimers();
    const store = new InMemoryApprovalStore();
    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({ role: 'tech-lead', timeoutSec: 60, onTimeout: 'auto-approve', store }),
        dependencies: ['design'],
      })
      .addStep('implement', {
        name: 'Implement',
        execute: async () => 'done',
        dependencies: ['gate'],
        condition: (deps) => (deps.gate as { status: string }).status === 'approved',
      })
      .build({ approvalStore: store });

    const suspended = await workflow.run('feature', { workflowId: 'wf-timeout' });
    vi.advanceTimersByTime(61_000);

    const completed = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-timeout',
      stepOutput: approveDecision(),
    });

    expect(completed.status).toBe('completed');
    expect(completed.outputs.gate).toMatchObject({ status: 'approved' });
    expect((completed.outputs.gate as { decisions: ApprovalDecision[] }).decisions[0]?.approver.id).toBe(
      'system',
    );
  });

  it('escalates expired approvals to the next role', async () => {
    vi.useFakeTimers();
    const store = new InMemoryApprovalStore();
    const dispatched: ApprovalRequest[] = [];
    const dispatcher = new CallbackDispatcher({
      callback: async (request) => {
        dispatched.push(request);
      },
    });

    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async () => ({ doc: 'design-v1' }),
      })
      .addStep('gate', {
        ...humanApproval({
          role: 'tech-lead',
          timeoutSec: 60,
          onTimeout: 'escalate',
          escalationRoles: ['tech-lead', 'director'],
          store,
          dispatcher,
        }),
        dependencies: ['design'],
      })
      .build({ approvalStore: store });

    const suspended = await workflow.run('feature', { workflowId: 'wf-escalate' });
    vi.advanceTimersByTime(61_000);

    const escalated = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-escalate',
      stepOutput: approveDecision(),
    });

    expect(escalated.status).toBe('suspended');
    expect(escalated.suspensionMessage).toContain('director');
    expect(dispatched.at(-1)?.role).toBe('director');
  });
});

describe('InMemoryApprovalStore', () => {
  it('supports create, record, list pending, and fetch decisions', async () => {
    const store = new InMemoryApprovalStore();
    const request = {
      workflowId: 'wf-store',
      stepId: 'gate',
      role: 'tech-lead',
      payload: { doc: 'v1' },
      expiresAt: Date.now() + 60_000,
      requiredApprovals: 2,
    };

    await store.createRequest(request);
    expect(await store.getPendingRequests({ role: 'tech-lead' })).toHaveLength(1);

    await store.recordDecision('wf-store', 'gate', approveDecision({ approver: { id: 'a', role: 'tech-lead' } }));
    expect(await store.getPendingRequests()).toHaveLength(1);
    expect(await store.getDecisions('wf-store', 'gate')).toHaveLength(1);

    await store.recordDecision('wf-store', 'gate', approveDecision({ approver: { id: 'b', role: 'tech-lead' } }));
    expect(await store.getPendingRequests()).toHaveLength(0);
    expect(await store.getDecisions('wf-store', 'gate')).toHaveLength(2);
  });
});

describe('WebhookDispatcher', () => {
  it('POSTs the approval request payload', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const dispatcher = new WebhookDispatcher({
      url: 'https://example.com/approvals',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const request = {
      workflowId: 'wf-hook',
      stepId: 'gate',
      role: 'tech-lead',
      payload: { doc: 'v1' },
      expiresAt: Date.now() + 60_000,
    };

    await dispatcher.notify(request);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/approvals',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
      }),
    );
  });
});

describe('DecisionSigner', () => {
  it('signs and verifies approval decisions', () => {
    const decision = approveDecision({ reason: 'Looks good' });
    const token = signJwt(decision, 'test-secret');
    const verified = verifyJwt(token, 'test-secret');

    expect(verified.action).toBe('approve');
    expect(verified.reason).toBe('Looks good');
    expect(verified.approver.id).toBe('user-1');
  });
});

describe('humanApproval full integration', () => {
  it('runs design → approval gate → implement with state store persistence', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const stateStore = new InMemoryStateStore();
    const workflow = new DAGBuilder()
      .addStep('design', {
        name: 'Design',
        execute: async (input: string) => ({ doc: `${input}-design` }),
      })
      .addStep('gate', {
        ...humanApproval({
          role: 'tech-lead',
          onTimeout: 'reject',
          store: approvalStore,
          schema: z.object({
            action: z.enum(['approve', 'reject', 'redirect']),
            approver: z.object({ id: z.string(), role: z.string() }),
            timestamp: z.number(),
          }),
        }),
        dependencies: ['design'],
      })
      .addStep('implement', {
        name: 'Implement',
        execute: async (input: { doc: string }) => `implemented:${input.doc}`,
        dependencies: ['gate'],
        inputMapper: (deps) => (deps.gate as { payload: { design: { doc: string } } }).payload.design,
        condition: (deps) => (deps.gate as { status: string }).status === 'approved',
      })
      .build({ approvalStore, stateStore });

    const persisted = workflow.suspendTo(stateStore);
    const suspended = await persisted.run('feature-x', { workflowId: 'wf-full' });
    expect(suspended.status).toBe('suspended');
    expect(await stateStore.load('wf-full')).not.toBeNull();

    const completed = await persisted.resume({
      workflowId: 'wf-full',
      stepOutput: approveDecision(),
    });

    expect(completed.status).toBe('completed');
    expect(completed.finalOutput).toBe('implemented:feature-x-design');
    expect(await stateStore.load('wf-full')).toBeNull();
  });
});

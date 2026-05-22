import { describe, expect, it } from 'vitest';
import { DAGBuilder, DAGWorkflow, WorkflowResumeError, functionStep } from '../../src/orchestration/dag.js';
import { InMemoryStateStore } from '../../src/orchestration/state-store.js';

function buildReviewWorkflow() {
  return new DAGBuilder()
    .addStep('draft', {
      name: 'Draft Email',
      execute: async (input: string) => `Draft for: ${input}`,
    })
    .addStep('review', {
      name: 'Human Review',
      suspend: true,
      execute: async (input) => input,
      dependencies: ['draft'],
    })
    .addStep('send', {
      name: 'Send Email',
      execute: async (input: { approved: boolean; edits?: string }) =>
        input.approved ? `Sent with edits: ${input.edits ?? 'none'}` : 'Not sent',
      dependencies: ['review'],
      inputMapper: (deps) => deps.review as { approved: boolean; edits?: string },
    })
    .build();
}

describe('DAGWorkflow suspend/resume', () => {
  it('suspends at a marked step', async () => {
    const workflow = buildReviewWorkflow();
    const result = await workflow.run('Quarterly update', { workflowId: 'wf-1' });

    expect(result.status).toBe('suspended');
    expect(result.suspendedState?.workflowId).toBe('wf-1');
    expect(result.suspendedState?.currentStepId).toBe('review');
    expect(result.suspendedState?.completedSteps.draft).toBe('Draft for: Quarterly update');
    expect(result.suspensionMessage).toContain('Human Review');
    expect(result.outputs.send).toBeUndefined();
  });

  it('resumes from a suspension point and completes the workflow', async () => {
    const workflow = buildReviewWorkflow();
    const suspended = await workflow.run('Product launch', { workflowId: 'wf-2' });

    const finalResult = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-2',
      stepOutput: { approved: true, edits: 'Changed the subject line' },
    });

    expect(finalResult.status).toBe('completed');
    expect(finalResult.outputs.review).toEqual({
      approved: true,
      edits: 'Changed the subject line',
    });
    expect(finalResult.finalOutput).toBe('Sent with edits: Changed the subject line');
    expect(finalResult.outputs.draft).toBe('Draft for: Product launch');
  });

  it('supports multiple suspension points in one workflow run', async () => {
    const workflow = new DAGBuilder()
      .addStep('draft', {
        name: 'Draft',
        execute: async () => 'draft-body',
      })
      .addStep('review', {
        name: 'Review',
        suspend: true,
        execute: async (input) => input,
        dependencies: ['draft'],
      })
      .addStep('approve', {
        name: 'Approve',
        suspend: true,
        execute: async (input) => input,
        dependencies: ['review'],
      })
      .addStep('send', {
        name: 'Send',
        execute: async (input: string) => `sent:${input}`,
        dependencies: ['approve'],
        inputMapper: (deps) => String(deps.approve),
      })
      .build();

    const first = await workflow.run('task', { workflowId: 'wf-multi' });
    expect(first.status).toBe('suspended');
    expect(first.suspendedState?.currentStepId).toBe('review');

    const second = await workflow.resume(first.suspendedState!, {
      workflowId: 'wf-multi',
      stepOutput: 'reviewed-body',
    });
    expect(second.status).toBe('suspended');
    expect(second.suspendedState?.currentStepId).toBe('approve');
    expect(second.outputs.review).toBe('reviewed-body');

    const finalResult = await workflow.resume(second.suspendedState!, {
      workflowId: 'wf-multi',
      stepOutput: 'approved-body',
    });
    expect(finalResult.status).toBe('completed');
    expect(finalResult.finalOutput).toBe('sent:approved-body');
  });

  it('roundtrips suspended state through JSON serialization', async () => {
    const workflow = buildReviewWorkflow();
    const suspended = await workflow.run('Serializable task', { workflowId: 'wf-json' });

    const serialized = JSON.stringify(suspended.suspendedState);
    const restoredState = JSON.parse(serialized);

    const finalResult = await workflow.resume(restoredState, {
      workflowId: 'wf-json',
      stepOutput: { approved: true },
    });

    expect(finalResult.status).toBe('completed');
    expect(finalResult.outputs.draft).toBe('Draft for: Serializable task');
  });

  it('throws when resume workflowId does not match saved state', async () => {
    const workflow = buildReviewWorkflow();
    const suspended = await workflow.run('Mismatch test', { workflowId: 'wf-expected' });

    await expect(
      workflow.resume(suspended.suspendedState!, {
        workflowId: 'wf-wrong',
        stepOutput: { approved: true },
      }),
    ).rejects.toThrow(WorkflowResumeError);
  });

  it('preserves completed step outputs across suspend and resume', async () => {
    const workflow = new DAGBuilder()
      .addStep('research', {
        name: 'Research',
        execute: async () => ({ facts: ['a', 'b'] }),
      })
      .addStep('outline', {
        name: 'Outline',
        execute: async (input) => ({ outline: input, sections: 3 }),
        dependencies: ['research'],
        inputMapper: (deps) => deps.research,
      })
      .addStep('review', {
        name: 'Review Outline',
        suspend: true,
        execute: async (input) => input,
        dependencies: ['outline'],
      })
      .addStep('publish', {
        name: 'Publish',
        execute: async (input) => input,
        dependencies: ['review'],
        inputMapper: (deps) => deps.review,
      })
      .build();

    const suspended = await workflow.run('article', { workflowId: 'wf-preserve' });

    expect(suspended.outputs.research).toEqual({ facts: ['a', 'b'] });
    expect(suspended.outputs.outline).toEqual({
      outline: { facts: ['a', 'b'] },
      sections: 3,
    });

    const finalResult = await workflow.resume(suspended.suspendedState!, {
      workflowId: 'wf-preserve',
      stepOutput: { approved: true },
    });

    expect(finalResult.outputs.research).toEqual({ facts: ['a', 'b'] });
    expect(finalResult.outputs.outline).toEqual({
      outline: { facts: ['a', 'b'] },
      sections: 3,
    });
    expect(finalResult.outputs.review).toEqual({ approved: true });
    expect(finalResult.finalOutput).toEqual({ approved: true });
  });

  it('throws when resuming against a different workflow definition', async () => {
    const workflowA = buildReviewWorkflow();
    const suspended = await workflowA.run('task', { workflowId: 'wf-mismatch' });

    const workflowB = new DAGBuilder()
      .addStep('draft', { name: 'Draft', execute: async () => 'x' })
      .addStep('review', {
        name: 'Review',
        suspend: true,
        execute: async (input) => input,
        dependencies: ['draft'],
      })
      .addStep('extra', { name: 'Extra', execute: async () => 'y' })
      .build();

    await expect(
      workflowB.resume(suspended.suspendedState!, {
        workflowId: 'wf-mismatch',
        stepOutput: { approved: true },
      }),
    ).rejects.toThrow('Workflow definition does not match');
  });
});

describe('InMemoryStateStore', () => {
  it('supports save, load, list, and delete', async () => {
    const store = new InMemoryStateStore();
    const state = {
      workflowId: 'store-1',
      completedSteps: { draft: 'hello' },
      skippedSteps: [],
      stepDurations: { draft: 12 },
      currentStepId: 'review',
      suspendedAt: Date.now(),
      workflowInput: 'task',
      pendingStepInput: { draft: 'hello' },
      suspensionMessage: 'Waiting for review',
    };

    await store.save(state);
    expect(await store.load('store-1')).toEqual(state);
    expect(await store.list()).toHaveLength(1);

    const loaded = await store.load('store-1');
    const finalWorkflow = buildReviewWorkflow();
    const result = await finalWorkflow.resume(loaded!, {
      workflowId: 'store-1',
      stepOutput: { approved: true, edits: 'Updated intro' },
    });
    expect(result.status).toBe('completed');

    await store.delete('store-1');
    expect(await store.load('store-1')).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it('returns independent clones on load', async () => {
    const store = new InMemoryStateStore();
    const state = {
      workflowId: 'clone-test',
      completedSteps: {},
      skippedSteps: [],
      stepDurations: {},
      currentStepId: 'review',
      suspendedAt: 1,
      workflowInput: 'task',
    };

    await store.save(state);
    const loaded = await store.load('clone-test');
    loaded!.completedSteps.draft = 'mutated';

    expect((await store.load('clone-test'))!.completedSteps.draft).toBeUndefined();
  });
});

describe('DAGWorkflow.run with workflowId option', () => {
  it('uses DAGBuilder suspend steps in a linear workflow', async () => {
    const workflow = new DAGBuilder()
      .addStep('draft', { name: 'Draft', execute: async () => 'body' })
      .addStep('review', {
        name: 'Review',
        suspend: true,
        execute: async (input) => input,
        dependencies: ['draft'],
      })
      .addStep('send', {
        name: 'Send',
        execute: async () => 'sent',
        dependencies: ['review'],
      })
      .build();

    const result = await workflow.run('input');
    expect(result.status).toBe('suspended');
    expect(result.suspendedState?.pendingStepInput).toEqual({ draft: 'body' });
  });
});

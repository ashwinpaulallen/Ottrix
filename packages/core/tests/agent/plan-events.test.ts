import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { Planner } from '../../src/agent/planner.js';
import { Reflector } from '../../src/agent/reflector.js';
import { agentEventToSse } from '../../src/http/sse.js';
import type { AgentEvent } from '../../src/types/agent.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

const usage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 };

describe('plan lifecycle events', () => {
  it('emits plan_created when the planner creates a plan', async () => {
    const events: AgentEvent[] = [];
    const planner = new Planner({ mode: 'rules' });
    planner.setEventEmitter((event) => events.push(event));

    const plan = await planner.plan('Please research climate trends');
    const created = events.find((event) => event.type === 'plan_created');

    expect(created?.type).toBe('plan_created');
    if (created?.type !== 'plan_created') {
      return;
    }
    expect(created.data.planId).toBe(plan.id);
    expect(created.data.stepCount).toBe(plan.steps.length);
    expect(created.data.steps[0]?.dependencies).toEqual([]);
    expect(created.data.reasoning).toContain('Research');
  });

  it('emits plan_validated with valid and issues', () => {
    const events: AgentEvent[] = [];
    const planner = new Planner({ mode: 'rules' });
    planner.setEventEmitter((event) => events.push(event));

    const valid = planner.validate({
      id: 'plan-ok',
      reasoning: 'ok',
      steps: [
        { id: 'a', description: 'First', dependencies: [] },
        { id: 'b', description: 'Second', dependencies: ['a'] },
      ],
    });
    const invalid = planner.validate({
      id: 'plan-bad',
      reasoning: 'bad',
      steps: [{ id: 'a', description: 'A', dependencies: ['missing'] }],
    });

    const validated = events.filter((event) => event.type === 'plan_validated');
    expect(valid.valid).toBe(true);
    expect(validated[0]).toMatchObject({
      type: 'plan_validated',
      data: { planId: 'plan-ok', valid: true },
    });
    expect(invalid.valid).toBe(false);
    expect(validated[1]).toMatchObject({
      type: 'plan_validated',
      data: { planId: 'plan-bad', valid: false },
    });
    if (validated[1]?.type === 'plan_validated') {
      expect(validated[1].data.issues?.some((issue) => issue.includes('unknown'))).toBe(true);
    }
  });

  it('emits plan_step_started before controlled execution and plan_step_completed after', async () => {
    const events: AgentEvent[] = [];
    const planner = new Planner({ mode: 'rules' });
    const plan = await planner.plan('Please research climate trends');
    const agent = new Agent({
      name: 'test',
      provider: new MockCompletionProvider(),
      onAgentEvent: (event) => events.push(event),
    });
    const order: string[] = [];

    const status = await agent.executeControlledPlanStep({
      plan,
      stepId: plan.steps[0]!.id,
      execute: async () => {
        order.push('execute');
        expect(events.some((event) => event.type === 'plan_step_started')).toBe(true);
        expect(events.some((event) => event.type === 'plan_step_completed')).toBe(false);
        return { tokenUsage: usage };
      },
    });

    order.push('after');
    const completed = events.find((event) => event.type === 'plan_step_completed');
    expect(status).toBe('completed');
    expect(order).toEqual(['execute', 'after']);
    expect(completed?.type).toBe('plan_step_completed');
    if (completed?.type === 'plan_step_completed') {
      expect(completed.data.durationMs).toBeGreaterThanOrEqual(0);
      expect(completed.data.tokenUsage).toEqual(usage);
      expect(completed.data.planId).toBe(plan.id);
    }
  });

  it('does not emit step events when dependencies are not satisfied', async () => {
    const events: AgentEvent[] = [];
    const planner = new Planner({ mode: 'rules' });
    const plan = await planner.plan('Please research climate trends');
    const agent = new Agent({
      name: 'test',
      provider: new MockCompletionProvider(),
      onAgentEvent: (event) => events.push(event),
    });
    const dependent = plan.steps.find((step) => step.dependencies.length > 0);

    const status = await agent.executeControlledPlanStep({
      plan,
      stepId: dependent!.id,
      execute: async () => {
        throw new Error('should not run');
      },
    });

    expect(status).toBe('blocked');
    expect(events.some((event) => event.type === 'plan_step_started')).toBe(false);
  });

  it('emits plan_step_failed with the retryable flag', async () => {
    const events: AgentEvent[] = [];
    const planner = new Planner({ mode: 'rules' });
    const plan = await planner.plan('Say hello');
    const agent = new Agent({
      name: 'test',
      provider: new MockCompletionProvider(),
      onAgentEvent: (event) => events.push(event),
    });

    const status = await agent.executeControlledPlanStep({
      plan,
      stepId: plan.steps[0]!.id,
      execute: async () => {
        throw Object.assign(new Error('tool timed out'), { retryable: false });
      },
    });

    const failed = events.find((event) => event.type === 'plan_step_failed');
    expect(status).toBe('failed');
    expect(events.some((event) => event.type === 'plan_step_started')).toBe(true);
    expect(failed).toMatchObject({
      type: 'plan_step_failed',
      data: { reason: 'tool timed out', retryable: false, stepId: plan.steps[0]!.id },
    });
  });

  it('emits plan_revised when the plan changes mid-run', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockCompletionProvider().enqueue(textCompletion('A partial draft.', usage));
    const reflectorProvider = new MockCompletionProvider()
      .enqueue(textCompletion(JSON.stringify({ onTrack: false, confidence: 0.2, suggestion: 'refocus' })))
      .enqueue(textCompletion(JSON.stringify({ shouldContinue: false, reason: 'stop' })))
      .enqueue(textCompletion(JSON.stringify({ goalMet: false, quality: 0.2 })));

    const agent = new Agent({
      name: 'test',
      provider,
      planner: new Planner({ mode: 'rules' }),
      reflector: new Reflector({ provider: reflectorProvider }),
      onAgentEvent: (event) => events.push(event),
    });

    await agent.run('Please research climate trends');

    const revised = events.find((event) => event.type === 'plan_revised');
    expect(revised?.type).toBe('plan_revised');
    if (revised?.type === 'plan_revised') {
      expect(revised.data.previousStepCount).toBeGreaterThan(0);
      expect(revised.data.newStepCount).toBeGreaterThan(0);
      expect(revised.data.planId).toBeTruthy();
      expect(revised.data.reason.length).toBeGreaterThan(0);
    }
    expect(events.some((event) => event.type === 'plan_step_started')).toBe(false);
  });

  it('yields plan events from agent.stream() beside text events', async () => {
    const provider = new MockCompletionProvider().enqueueStream(
      textCompletion('Research summary for the stream.', usage),
    );
    const agent = new Agent({
      name: 'test',
      provider,
      planner: new Planner({ mode: 'rules' }),
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('Please research climate trends')) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types).toContain('plan_created');
    expect(types).toContain('plan_validated');
    expect(types).toContain('text');
    expect(types).toContain('done');
    expect(types).not.toContain('plan_step_started');
    expect(types.indexOf('plan_created')).toBeLessThan(types.indexOf('text'));

    const created = events.find((event) => event.type === 'plan_created');
    expect(created).toBeDefined();
    if (created) {
      expect(agentEventToSse(created, 0).event).toBe('plan_created');
    }
  });
});

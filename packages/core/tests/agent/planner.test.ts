import { describe, expect, it } from 'vitest';
import {
  Planner,
  mergeRevisedPlan,
  parsePlanFromJson,
  type Plan,
  type PlanStep,
} from '../../src/agent/planner.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

const VALID_PLAN_JSON = JSON.stringify({
  reasoning: 'Break into research and answer phases.',
  steps: [
    { id: 'step_1', description: 'Search for data', dependencies: [], toolHint: 'search' },
    { id: 'step_2', description: 'Summarize findings', dependencies: ['step_1'] },
  ],
});

describe('Planner', () => {
  describe('rule-based planning', () => {
    it('matches research goals with multi-step plan', async () => {
      const planner = new Planner({ mode: 'rules' });
      const plan = await planner.plan('Please research the history of TypeScript');

      expect(plan.steps.length).toBeGreaterThanOrEqual(2);
      expect(plan.steps[0]?.toolHint).toBe('search');
      expect(plan.reasoning).toContain('Research');
    });

    it('falls back to single-step plan when no rule matches', async () => {
      const planner = new Planner({ mode: 'rules' });
      const plan = await planner.plan('Say hello');

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]?.description).toBe('Say hello');
    });

    it('uses custom rules', async () => {
      const planner = new Planner({
        mode: 'rules',
        rules: [
          {
            pattern: 'deploy',
            reasoning: 'Deploy workflow',
            buildSteps: () => [
              { description: 'Build artifact', dependencies: [] },
              { description: 'Deploy to production', dependencies: ['step_1'] },
            ],
          },
        ],
      });

      const plan = await planner.plan('deploy the app');
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[1]?.dependencies).toEqual(['step_1']);
    });
  });

  describe('LLM-based planning', () => {
    it('parses provider JSON into a plan', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion(VALID_PLAN_JSON),
      );
      const planner = new Planner({ provider, mode: 'llm' });

      const plan = await planner.plan('Research quantum computing');

      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0]?.id).toBe('step_1');
      expect(plan.reasoning).toContain('research');
    });
  });

  describe('validate', () => {
    it('accepts a valid DAG plan', () => {
      const planner = new Planner({ mode: 'rules' });
      const plan: Plan = {
        reasoning: 'ok',
        steps: [
          { id: 'a', description: 'First', dependencies: [] },
          { id: 'b', description: 'Second', dependencies: ['a'] },
        ],
      };

      const result = planner.validate(plan);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects circular dependencies', () => {
      const planner = new Planner({ mode: 'rules' });
      const plan: Plan = {
        reasoning: 'bad',
        steps: [
          { id: 'a', description: 'A', dependencies: ['b'] },
          { id: 'b', description: 'B', dependencies: ['a'] },
        ],
      };

      const result = planner.validate(plan);
      expect(result.valid).toBe(false);
      expect(result.circularDependencies.length).toBeGreaterThan(0);
    });

    it('detects unknown dependency references', () => {
      const planner = new Planner({ mode: 'rules' });
      const plan: Plan = {
        reasoning: 'bad',
        steps: [{ id: 'a', description: 'A', dependencies: ['missing'] }],
      };

      const result = planner.validate(plan);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('unknown'))).toBe(true);
    });

    it('detects unreachable steps in a cyclic dependency graph', () => {
      const planner = new Planner({ mode: 'rules' });
      const plan: Plan = {
        reasoning: 'bad',
        steps: [
          { id: 'a', description: 'A', dependencies: ['b'] },
          { id: 'b', description: 'B', dependencies: ['a'] },
          { id: 'c', description: 'C', dependencies: ['a'] },
        ],
      };

      const result = planner.validate(plan);
      expect(result.unreachableSteps.length).toBeGreaterThan(0);
    });
  });

  describe('replan', () => {
    it('revises plan with LLM when provider is available', async () => {
      const revisedJson = JSON.stringify({
        reasoning: 'Remaining work',
        steps: [{ id: 'step_3', description: 'Finalize report', dependencies: [] }],
      });
      const provider = new MockCompletionProvider().enqueue(textCompletion(revisedJson));
      const planner = new Planner({ provider, mode: 'llm' });

      const completed: PlanStep[] = [
        { id: 'step_1', description: 'Search', dependencies: [] },
      ];
      const plan = await planner.replan('Write a report', completed, ['found 10 sources']);

      expect(plan.steps.some((s) => s.description.includes('Finalize'))).toBe(true);
    });

    it('revises plan with rules when in rules mode', async () => {
      const planner = new Planner({ mode: 'rules' });
      const completed: PlanStep[] = [
        { id: 'step_1', description: 'Gather info', dependencies: [] },
      ];

      const plan = await planner.replan(
        'research AI safety',
        completed,
        ['partial notes'],
      );

      expect(plan.steps.length).toBeGreaterThan(completed.length);
    });
  });

  describe('parsePlanFromJson', () => {
    it('parses fenced JSON', () => {
      const plan = parsePlanFromJson(
        '```json\n' + VALID_PLAN_JSON + '\n```',
      );
      expect(plan.steps).toHaveLength(2);
    });

    it('parses JSON with leading prose before a fenced block', () => {
      const plan = parsePlanFromJson(
        `Here is the plan:\n\`\`\`json\n${VALID_PLAN_JSON}\n\`\`\``,
      );
      expect(plan.steps).toHaveLength(2);
    });

    it('assigns default ids when missing', () => {
      const plan = parsePlanFromJson(
        JSON.stringify({
          steps: [{ description: 'Do something', dependencies: [] }],
        }),
      );
      expect(plan.steps[0]?.id).toBe('step_1');
    });
  });

  describe('mergeRevisedPlan', () => {
    it('deduplicates completed steps from LLM revised plans', () => {
      const completed: PlanStep[] = [
        { id: 'step_1', description: 'Search', dependencies: [] },
      ];
      const revised: Plan = {
        reasoning: 'Continue',
        steps: [
          { id: 'step_1', description: 'Search', dependencies: [] },
          { id: 'step_2', description: 'Summarize', dependencies: ['step_1'] },
        ],
      };

      const merged = mergeRevisedPlan(completed, revised);
      expect(merged.steps.map((s) => s.id)).toEqual(['step_1', 'step_2']);
    });

    it('adds a finalize step when revised plan has no remaining steps', () => {
      const completed: PlanStep[] = [
        { id: 'step_1', description: 'Done', dependencies: [] },
      ];
      const merged = mergeRevisedPlan(completed, {
        reasoning: 'done',
        steps: [{ id: 'step_1', description: 'Done', dependencies: [] }],
      });

      expect(merged.steps.length).toBe(2);
      expect(merged.steps[1]?.description).toContain('Finalize');
    });
  });

  describe('formatPlanForContext', () => {
    it('includes step descriptions and tool hints', () => {
      const planner = new Planner({ mode: 'rules' });
      const formatted = planner.formatPlanForContext({
        reasoning: 'Test',
        steps: [
          { id: 's1', description: 'Run tool', dependencies: [], toolHint: 'calc' },
        ],
      });

      expect(formatted).toContain('Run tool');
      expect(formatted).toContain('calc');
    });
  });
});

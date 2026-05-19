import type { CompletionProvider } from '../types/provider.js';
import { extractTextFromContent } from './messages.js';

/** A single step in an execution plan. */
export interface PlanStep {
  /** Unique step identifier. */
  id: string;
  /** What this step should accomplish. */
  description: string;
  /** IDs of steps that must complete before this one. */
  dependencies: string[];
  /** Optional suggested tool name for this step. */
  toolHint?: string;
}

/** A validated execution plan for a goal. */
export interface Plan {
  /** Ordered list of plan steps (may include dependency ordering). */
  steps: PlanStep[];
  /** Planner reasoning or rationale. */
  reasoning: string;
}

/** Result of validating a {@link Plan}. */
export interface PlanValidationResult {
  /** Whether the plan is structurally valid. */
  valid: boolean;
  /** Human-readable validation errors. */
  errors: string[];
  /** Step IDs that cannot be reached due to missing/broken dependencies. */
  unreachableSteps: string[];
  /** Dependency cycles, each cycle listed as step IDs. */
  circularDependencies: string[][];
}

/** Planning mode. */
export type PlannerMode = 'llm' | 'rules';

/**
 * Rule for pattern-based planning.
 *
 * `pattern` is tested against the goal (string match or RegExp).
 */
export interface PlanningRule {
  /** String substring or RegExp matched against the goal. */
  pattern: string | RegExp;
  /** Static steps or a factory that receives the goal. */
  buildSteps: (goal: string) => Array<Omit<PlanStep, 'id'> & { id?: string }>;
  /** Optional reasoning text attached to matched plans. */
  reasoning?: string;
}

/** Options for {@link Planner}. */
export interface PlannerOptions {
  /** LLM used for `llm` mode and re-planning. Required when `mode` is `'llm'`. */
  provider?: CompletionProvider;
  /** Planning strategy. @defaultValue 'llm' */
  mode?: PlannerMode;
  /** Rules used when `mode` is `'rules'` or as fallback when LLM planning fails. */
  rules?: PlanningRule[];
  /** System prompt override for LLM planning. */
  planningSystemPrompt?: string;
}

const DEFAULT_PLANNING_SYSTEM_PROMPT = `You are a task planner. Decompose the user's goal into clear, executable steps.
Respond with JSON only, no markdown fences:
{
  "reasoning": "brief explanation",
  "steps": [
    { "id": "step_1", "description": "...", "dependencies": [], "toolHint": "optional_tool_name" }
  ]
}
Use unique step ids (step_1, step_2, ...). dependencies must reference earlier step ids only.`;

const DEFAULT_RULES: PlanningRule[] = [
  {
    pattern: /research|find|search|look up|investigate/i,
    reasoning: 'Research tasks benefit from search then synthesis.',
    buildSteps: () => [
      { description: 'Gather relevant information on the topic', dependencies: [], toolHint: 'search' },
      { description: 'Summarize and synthesize findings', dependencies: ['step_1'] },
      { description: 'Present conclusions to the user', dependencies: ['step_2'] },
    ],
  },
  {
    pattern: /calculate|compute|math|sum|add|multiply/i,
    reasoning: 'Calculation tasks use a calculator tool when available.',
    buildSteps: (goal) => [
      { description: `Parse the calculation from: ${goal}`, dependencies: [] },
      { description: 'Perform the calculation', dependencies: ['step_1'], toolHint: 'calculator' },
      { description: 'Return the result with explanation', dependencies: ['step_2'] },
    ],
  },
  {
    pattern: /write|draft|compose|email|report/i,
    reasoning: 'Writing tasks follow outline → draft → review.',
    buildSteps: () => [
      { description: 'Create an outline of the document', dependencies: [] },
      { description: 'Write the full draft', dependencies: ['step_1'] },
      { description: 'Review and polish the final text', dependencies: ['step_2'] },
    ],
  },
];

/**
 * Produces and validates execution plans for agent goals.
 *
 * Supports LLM-based decomposition and configurable rule-based patterns.
 */
export class Planner {
  private readonly provider?: CompletionProvider;
  private readonly mode: PlannerMode;
  private readonly rules: PlanningRule[];
  private readonly planningSystemPrompt: string;

  /**
   * @param options - Provider, mode, and optional planning rules.
   */
  constructor(options: PlannerOptions = {}) {
    this.provider = options.provider;
    this.mode = options.mode ?? (options.provider ? 'llm' : 'rules');
    this.rules = options.rules ?? DEFAULT_RULES;
    this.planningSystemPrompt = options.planningSystemPrompt ?? DEFAULT_PLANNING_SYSTEM_PROMPT;
  }

  /**
   * Create a plan for the given goal.
   */
  async plan(goal: string): Promise<Plan> {
    if (this.mode === 'rules') {
      return this.planWithRules(goal);
    }

    if (!this.provider) {
      throw new Error('Planner requires a CompletionProvider when mode is "llm"');
    }

    try {
      return await this.planWithLlm(goal);
    } catch {
      const fallback = this.planWithRules(goal);
      return {
        ...fallback,
        reasoning: `LLM planning failed; using rule-based fallback. ${fallback.reasoning}`,
      };
    }
  }

  /**
   * Validate plan structure: unique ids, valid dependencies, no cycles, reachability.
   */
  validate(plan: Plan): PlanValidationResult {
    const errors: string[] = [];
    const ids = new Set<string>();
    const circularDependencies: string[][] = [];

    for (const step of plan.steps) {
      if (ids.has(step.id)) {
        errors.push(`Duplicate step id: ${step.id}`);
      }
      ids.add(step.id);
    }

    for (const step of plan.steps) {
      for (const dep of step.dependencies) {
        if (!ids.has(dep)) {
          errors.push(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
        if (dep === step.id) {
          errors.push(`Step "${step.id}" depends on itself`);
        }
      }
    }

    const cycles = detectCycles(plan.steps);
    circularDependencies.push(...cycles);
    if (cycles.length > 0) {
      errors.push(`Circular dependencies detected: ${cycles.map((c) => c.join(' → ')).join('; ')}`);
    }

    const unreachableSteps = findUnreachableSteps(plan.steps);

    if (unreachableSteps.length > 0) {
      errors.push(`Unreachable steps: ${unreachableSteps.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      unreachableSteps,
      circularDependencies,
    };
  }

  /**
   * Produce a revised plan given completed steps and partial results.
   */
  async replan(
    goal: string,
    completedSteps: PlanStep[],
    partialResults: unknown[],
  ): Promise<Plan> {
    if (this.mode === 'rules' || !this.provider) {
      return this.replanWithRules(goal, completedSteps, partialResults);
    }

    const context = formatReplanContext(completedSteps, partialResults);
    const result = await this.provider.complete({
      messages: [
        {
          role: 'user',
          content:
            `Original goal:\n${goal}\n\nCompleted plan steps and results:\n${context}\n\n` +
            'Produce a REVISED plan (JSON only) for remaining work. Keep completed step ids unchanged in your reasoning.',
        },
      ],
      systemPrompt: this.planningSystemPrompt,
      temperature: 0,
      maxTokens: 2048,
    });

    const text = extractTextFromContent(result.content);
    try {
      const revised = parsePlanFromJson(text);
      return mergeRevisedPlan(completedSteps, revised);
    } catch {
      return this.replanWithRules(goal, completedSteps, partialResults);
    }
  }

  /** Format a plan as markdown for injection into agent context. */
  formatPlanForContext(plan: Plan): string {
    const lines = plan.steps.map((s) => {
      const deps = s.dependencies.length > 0 ? ` (after: ${s.dependencies.join(', ')})` : '';
      const tool = s.toolHint ? ` [tool: ${s.toolHint}]` : '';
      return `- **${s.id}**: ${s.description}${deps}${tool}`;
    });
    return `## Execution plan\n${plan.reasoning}\n\n${lines.join('\n')}`;
  }

  private async planWithLlm(goal: string): Promise<Plan> {
    const result = await this.provider!.complete({
      messages: [{ role: 'user', content: `Goal:\n${goal}` }],
      systemPrompt: this.planningSystemPrompt,
      temperature: 0,
      maxTokens: 2048,
    });
    return parsePlanFromJson(extractTextFromContent(result.content));
  }

  private planWithRules(goal: string): Plan {
    for (const rule of this.rules) {
      if (matchesPattern(goal, rule.pattern)) {
        const steps = assignStepIds(rule.buildSteps(goal));
        return {
          steps,
          reasoning: rule.reasoning ?? `Matched planning rule for: ${String(rule.pattern)}`,
        };
      }
    }

    return {
      steps: [
        {
          id: 'step_1',
          description: goal,
          dependencies: [],
        },
      ],
      reasoning: 'No rule matched; using single-step plan.',
    };
  }

  private replanWithRules(
    goal: string,
    completedSteps: PlanStep[],
    partialResults: unknown[],
  ): Plan {
    const completedIds = new Set(completedSteps.map((s) => s.id));
    const base = this.planWithRules(goal);
    const remaining = base.steps.filter((s) => !completedIds.has(s.id));

    if (remaining.length === 0) {
      const lastCompleted = completedSteps[completedSteps.length - 1];
      remaining.push({
        id: `step_${completedSteps.length + 1}`,
        description: 'Finalize and deliver the answer to the user',
        dependencies: lastCompleted ? [lastCompleted.id] : [],
      });
    }

    const resultsNote =
      partialResults.length > 0
        ? ` Incorporated ${partialResults.length} partial result(s).`
        : '';

    return {
      steps: [...completedSteps, ...remaining],
      reasoning: `Revised plan after ${completedSteps.length} completed step(s).${resultsNote} ${base.reasoning}`,
    };
  }
}

/** Parse LLM JSON output into a {@link Plan}. */
export function parsePlanFromJson(text: string): Plan {
  const json = extractJsonObject(text);
  const parsed = JSON.parse(json) as {
    reasoning?: string;
    steps?: Array<Partial<PlanStep>>;
  };

  if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('Plan JSON must include a non-empty steps array');
  }

  const steps: PlanStep[] = parsed.steps.map((raw, index) => ({
    id: typeof raw.id === 'string' ? raw.id : `step_${index + 1}`,
    description: typeof raw.description === 'string' ? raw.description : `Step ${index + 1}`,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((d): d is string => typeof d === 'string')
      : [],
    toolHint: typeof raw.toolHint === 'string' ? raw.toolHint : undefined,
  }));

  return {
    steps,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'LLM-generated plan',
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/** Merge completed steps with a revised plan, avoiding duplicate step ids. */
export function mergeRevisedPlan(completedSteps: PlanStep[], revised: Plan): Plan {
  const completedIds = new Set(completedSteps.map((s) => s.id));
  const remaining = revised.steps.filter((s) => !completedIds.has(s.id));

  if (remaining.length === 0) {
    const lastCompleted = completedSteps[completedSteps.length - 1];
    remaining.push({
      id: `step_${completedSteps.length + 1}`,
      description: 'Finalize and deliver the answer to the user',
      dependencies: lastCompleted ? [lastCompleted.id] : [],
    });
  }

  return {
    steps: [...completedSteps, ...remaining],
    reasoning: revised.reasoning,
  };
}

function matchesPattern(goal: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    return goal.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(goal);
}

function assignStepIds(
  steps: Array<Omit<PlanStep, 'id'> & { id?: string }>,
): PlanStep[] {
  return steps.map((step, index) => ({
    id: step.id ?? `step_${index + 1}`,
    description: step.description,
    dependencies: step.dependencies,
    toolHint: step.toolHint,
  }));
}

function detectCycles(steps: PlanStep[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const step of steps) {
    graph.set(step.id, [...step.dependencies]);
  }

  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string): void => {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push([...stack.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      dfs(dep);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const id of graph.keys()) {
    dfs(id);
  }

  return cycles;
}

function findUnreachableSteps(steps: PlanStep[]): string[] {
  const ids = new Set(steps.map((s) => s.id));
  const unreachable: string[] = [];

  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!ids.has(dep)) {
        unreachable.push(step.id);
        break;
      }
    }
  }

  const completed = new Set<string>();
  const pending = new Map(steps.map((s) => [s.id, new Set(s.dependencies)]));

  let progress = true;
  while (progress) {
    progress = false;
    for (const [id, deps] of pending) {
      if (deps.size === 0) {
        completed.add(id);
        pending.delete(id);
        progress = true;
        for (const [, otherDeps] of pending) {
          otherDeps.delete(id);
        }
      }
    }
  }

  for (const id of pending.keys()) {
    if (!unreachable.includes(id)) {
      unreachable.push(id);
    }
  }

  return [...new Set(unreachable)];
}

function formatReplanContext(completedSteps: PlanStep[], partialResults: unknown[]): string {
  return completedSteps
    .map((step, i) => {
      const result = partialResults[i];
      const resultText =
        result === undefined
          ? '(no result)'
          : typeof result === 'string'
            ? result
            : JSON.stringify(result);
      return `- ${step.id}: ${step.description}\n  Result: ${resultText}`;
    })
    .join('\n');
}

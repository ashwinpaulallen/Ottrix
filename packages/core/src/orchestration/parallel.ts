import type { Agent } from '../agent/agent.js';
import type { AgentResult } from '../types/agent.js';
import { finalResultFromStep, mergeTokenUsage, runAgentStep, runWithConcurrency } from './runner.js';
import type { WorkflowConfig, WorkflowResult, WorkflowStep } from './types.js';

/** A single branch in a {@link ParallelWorkflow}. */
export interface ParallelWorkflowBranch {
  /** Agent to run. */
  agent: Agent;
  /** Optional display name override. */
  name?: string;
  /** Per-branch timeout override. */
  timeoutMs?: number;
  /** Fallback when the branch fails or times out. */
  fallback?: (error: Error) => AgentResult | Promise<AgentResult>;
}

/** Options for {@link ParallelWorkflow}. */
export interface ParallelWorkflowOptions {
  /** Branches to run concurrently. */
  branches: ParallelWorkflowBranch[];
  /**
   * Maximum concurrent agent runs.
   * @defaultValue branches.length (unlimited)
   */
  concurrency?: number;
  /**
   * Combines branch outputs into a single final result.
   * @defaultValue Uses the first successful branch result.
   */
  merge?: (steps: WorkflowStep[]) => AgentResult | Promise<AgentResult>;
  /** Shared workflow configuration. */
  config?: WorkflowConfig;
}

/**
 * Runs multiple agents concurrently on the same input.
 */
export class ParallelWorkflow {
  private readonly branches: ParallelWorkflowBranch[];
  private readonly concurrency: number;
  private readonly merge?: ParallelWorkflowOptions['merge'];
  private readonly config?: WorkflowConfig;

  /**
   * @param options - Branches, concurrency, and optional merge strategy.
   */
  constructor(options: ParallelWorkflowOptions) {
    this.branches = options.branches;
    this.concurrency = options.concurrency ?? options.branches.length;
    this.merge = options.merge;
    this.config = options.config;
  }

  /**
   * Execute all branches against the same input.
   */
  async run(input: string): Promise<WorkflowResult> {
    const started = Date.now();

    const tasks = this.branches.map(
      (branch) => () =>
        runAgentStep({
          agent: branch.agent,
          agentName: branch.name,
          input,
          config: this.config,
          timeoutMs: branch.timeoutMs,
          fallback: branch.fallback,
        }),
    );

    const steps = await runWithConcurrency(tasks, this.concurrency);
    const finalResult = this.merge
      ? await this.merge(steps)
      : this.defaultMerge(steps);

    return {
      finalResult,
      steps,
      duration: Date.now() - started,
    };
  }

  private defaultMerge(steps: WorkflowStep[]): AgentResult {
    const first = steps[0];
    if (!first) {
      throw new Error('ParallelWorkflow: no branches produced results');
    }

    return {
      ...finalResultFromStep(first),
      response: steps.map((s) => `[${s.agentName}]: ${s.result.response}`).join('\n\n'),
      totalTokens: mergeTokenUsage(steps.map((s) => s.result)),
      metadata: {
        ...first.result.metadata,
        parallelBranches: steps.length,
      },
    };
  }
}

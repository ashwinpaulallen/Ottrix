import type { Agent } from '../agent/agent.js';
import type { Reflector } from '../agent/reflector.js';
import type { AgentResult } from '../types/agent.js';
import { isGoalMet, mergeTokenUsage, runAgentStep } from './runner.js';
import type {
  SequentialMapperContext,
  WorkflowConfig,
  WorkflowResult,
  WorkflowStep,
} from './types.js';

/** A single step in a {@link SequentialWorkflow}. */
export interface SequentialWorkflowStep {
  /** Agent to run. */
  agent: Agent;
  /** Optional display name override. */
  name?: string;
  /**
   * Maps workflow input or the previous step's output into this agent's input.
   * @defaultValue Passes the previous response string, or the original input for the first step.
   */
  inputMapper?: (context: SequentialMapperContext, lastResult?: AgentResult) => string;
  /** Reflector for early termination (defaults to the agent's reflector). */
  reflector?: Reflector;
  /** Goal string used with the reflector (defaults to the original workflow input). */
  goal?: string;
}

/**
 * Runs agents in order, piping each output into the next step.
 */
export class SequentialWorkflow {
  private readonly steps: SequentialWorkflowStep[];
  private readonly config?: WorkflowConfig;

  /**
   * @param steps - Ordered agent steps with optional input mappers.
   * @param config - Shared workflow options.
   */
  constructor(steps: SequentialWorkflowStep[], config?: WorkflowConfig) {
    this.steps = steps;
    this.config = config;
  }

  /**
   * Execute the pipeline.
   *
   * @param input - Initial workflow input.
   */
  async run(input: string): Promise<WorkflowResult> {
    const started = Date.now();
    const workflowSteps: WorkflowStep[] = [];
    let lastResult: AgentResult | undefined;
    let earlyTerminated = false;

    for (let index = 0; index < this.steps.length; index++) {
      const stepDef = this.steps[index];
      if (!stepDef) {
        continue;
      }
      const stepInput = this.resolveInput(input, workflowSteps, lastResult, index, stepDef);

      const step = await runAgentStep({
        agent: stepDef.agent,
        agentName: stepDef.name,
        input: stepInput,
        config: this.config,
      });

      workflowSteps.push(step);
      lastResult = step.result;

      const reflector = stepDef.reflector ?? stepDef.agent.getReflector();
      const goal = stepDef.goal ?? input;

      if (reflector) {
        const goalMet = await isGoalMet(reflector, step.result, goal);
        if (goalMet) {
          earlyTerminated = true;
          break;
        }
      }
    }

    const finalStep = workflowSteps[workflowSteps.length - 1];
    if (!finalStep) {
      throw new Error('SequentialWorkflow: no steps executed');
    }

    return {
      finalResult: this.buildFinalResult(workflowSteps, finalStep),
      steps: workflowSteps,
      duration: Date.now() - started,
      earlyTerminated: earlyTerminated || undefined,
    };
  }

  private resolveInput(
    originalInput: string,
    priorSteps: WorkflowStep[],
    lastResult: AgentResult | undefined,
    stepIndex: number,
    stepDef: SequentialWorkflowStep,
  ): string {
    if (stepDef.inputMapper) {
      return stepDef.inputMapper(
        { originalInput, stepIndex, priorSteps },
        lastResult,
      );
    }

    if (lastResult) {
      return lastResult.response;
    }

    return originalInput;
  }

  private buildFinalResult(steps: WorkflowStep[], finalStep: WorkflowStep): AgentResult {
    return {
      ...finalStep.result,
      totalTokens: mergeTokenUsage(steps.map((s) => s.result)),
      metadata: {
        ...finalStep.result.metadata,
        workflowSteps: steps.length,
      },
    };
  }
}

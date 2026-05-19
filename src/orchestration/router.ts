import type { Agent } from '../agent/agent.js';
import { runAgentStep } from './runner.js';
import type { WorkflowConfig, WorkflowResult } from './types.js';

/** Selects which agent key should handle the input. */
export type WorkflowRouterFn = (input: string) => string | Promise<string>;

/** Options for {@link RouterWorkflow}. */
export interface RouterWorkflowOptions {
  /** Routing function (rule-based or LLM-driven). */
  route: WorkflowRouterFn;
  /** Named agents available for routing. */
  agents: Record<string, Agent>;
  /** Agent used when routing returns an unknown key. */
  fallbackAgent?: Agent;
  /** Shared workflow configuration. */
  config?: WorkflowConfig;
}

/**
 * Routes each input to a single selected agent.
 */
export class RouterWorkflow {
  private readonly route: WorkflowRouterFn;
  private readonly agents: Record<string, Agent>;
  private readonly fallbackAgent?: Agent;
  private readonly config?: WorkflowConfig;

  /**
   * @param options - Router function and agent map.
   */
  constructor(options: RouterWorkflowOptions) {
    this.route = options.route;
    this.agents = options.agents;
    this.fallbackAgent = options.fallbackAgent;
    this.config = options.config;
  }

  /**
   * Route the input and run the selected agent.
   */
  async run(input: string): Promise<WorkflowResult> {
    const started = Date.now();
    const routeKey = await this.route(input);
    const agent = this.agents[routeKey] ?? this.fallbackAgent;

    if (!agent) {
      throw new Error(
        `RouterWorkflow: no agent for route "${routeKey}" and no fallbackAgent configured`,
      );
    }

    const agentName =
      agent === this.fallbackAgent && !this.agents[routeKey]
        ? this.findAgentName(agent)
        : routeKey;

    const step = await runAgentStep({
      agent,
      agentName,
      input,
      config: this.config,
    });

    return {
      finalResult: step.result,
      steps: [step],
      duration: Date.now() - started,
    };
  }

  private findAgentName(agent: Agent): string {
    for (const [name, candidate] of Object.entries(this.agents)) {
      if (candidate === agent) {
        return name;
      }
    }
    return agent.getName();
  }
}

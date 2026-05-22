import { Agent } from '../agent/agent.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  buildWorkerRosterLines,
  DELEGATE_TOOL_NAME,
  delegateLimitMessage,
  registerDelegateTool,
  requireToolRegistry,
  unknownWorkerMessage,
  workerFailureMessage,
  type DelegateToolInput,
} from './delegation.js';
import { runAgentStep, WorkflowTimeoutError } from './runner.js';
import type { WorkflowConfig, WorkflowResult, WorkflowStep } from './types.js';

/** A worker agent or nested hierarchical workflow. */
export type HierarchicalWorker = Agent | HierarchicalWorkflow;

/** Options for {@link HierarchicalWorkflow}. */
export interface HierarchicalWorkflowOptions {
  /** Manager agent that can call the `delegate` tool. */
  manager: Agent;
  /** Worker agents keyed by name. */
  workers: Record<string, HierarchicalWorker>;
  /**
   * Tool registry shared with the manager (required for delegate injection).
   * When omitted, uses {@link Agent.getToolRegistry} from the manager.
   */
  toolRegistry?: ToolRegistry;
  /** Optional descriptions surfaced to the manager in the system prompt. */
  workerDescriptions?: Record<string, string>;
  /** Maximum delegate tool invocations per run. @defaultValue 10 */
  maxDelegations?: number;
  /** Shared workflow configuration. */
  config?: WorkflowConfig;
}

/**
 * Manager/worker hierarchy where the manager delegates via a `delegate` tool.
 */
export class HierarchicalWorkflow {
  private readonly manager: Agent;
  private readonly workers: Record<string, HierarchicalWorker>;
  private readonly toolRegistry: ToolRegistry;
  private readonly workerDescriptions: Record<string, string>;
  private readonly maxDelegations: number;
  private readonly config?: WorkflowConfig;
  private delegationCount = 0;
  private readonly delegationSteps: WorkflowStep[] = [];

  /**
   * @param options - Manager, workers, and shared tool registry.
   */
  constructor(options: HierarchicalWorkflowOptions) {
    this.manager = options.manager;
    this.workers = options.workers;
    this.workerDescriptions = options.workerDescriptions ?? {};
    this.maxDelegations = options.maxDelegations ?? 10;
    this.config = options.config;

    this.toolRegistry = requireToolRegistry(
      options.toolRegistry,
      options.manager.getToolRegistry(),
      'HierarchicalWorkflow',
    );
    this.registerDelegateTool();
  }

  /** Display name of the manager agent. */
  getName(): string {
    return this.manager.getName();
  }

  /**
   * Run the manager, which may delegate subtasks to workers.
   */
  async run(input: string): Promise<WorkflowResult> {
    const started = Date.now();
    this.delegationCount = 0;
    this.delegationSteps.length = 0;

    const workerList = buildWorkerRosterLines(Object.keys(this.workers), this.workerDescriptions).join(
      '\n',
    );

    const managerInput =
      `${input}\n\n` +
      `You can delegate subtasks to workers using the "${DELEGATE_TOOL_NAME}" tool.\n` +
      `Available workers:\n${workerList}`;

    const managerStep = await runAgentStep({
      agent: this.manager,
      input: managerInput,
      config: this.config,
    });

    const steps = [...this.delegationSteps, managerStep];

    return {
      finalResult: {
        ...managerStep.result,
        metadata: {
          ...managerStep.result.metadata,
          delegations: this.delegationSteps.length,
        },
      },
      steps,
      duration: Date.now() - started,
    };
  }

  private registerDelegateTool(): void {
    registerDelegateTool(
      this.toolRegistry,
      Object.keys(this.workers),
      (delegateInput) => this.executeDelegation(delegateInput),
    );
  }

  private async executeDelegation(input: DelegateToolInput): Promise<string> {
    if (this.delegationCount >= this.maxDelegations) {
      return delegateLimitMessage(this.maxDelegations);
    }

    const worker = this.workers[input.worker];
    if (!worker) {
      return unknownWorkerMessage(input.worker, Object.keys(this.workers));
    }

    this.delegationCount += 1;

    try {
      if (worker instanceof HierarchicalWorkflow) {
        const nested = await worker.run(input.task);
        this.delegationSteps.push(...nested.steps);
        return nested.finalResult.response;
      }

      const step = await runAgentStep({
        agent: worker,
        agentName: input.worker,
        input: input.task,
        config: this.config,
      });

      this.delegationSteps.push(step);
      return step.result.response;
    } catch (error) {
      const message =
        error instanceof WorkflowTimeoutError
          ? `${input.worker} timed out`
          : error instanceof Error
            ? error.message
            : String(error);
      return workerFailureMessage(input.worker, message);
    }
  }
}

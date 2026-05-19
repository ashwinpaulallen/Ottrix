import { Agent } from '../agent/agent.js';
import { FunctionTool } from '../tools/function-tool.js';
import type { ToolRegistry } from '../tools/registry.js';
import { runAgentStep } from './runner.js';
import type { WorkflowConfig, WorkflowResult, WorkflowStep } from './types.js';

const DELEGATE_TOOL_NAME = 'delegate';

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

    const registry = options.toolRegistry ?? options.manager.getToolRegistry();
    if (!registry) {
      throw new Error(
        'HierarchicalWorkflow requires a ToolRegistry on the manager (config.toolRegistry)',
      );
    }
    this.toolRegistry = registry;
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

    const workerList = Object.keys(this.workers)
      .map((name) => {
        const description = this.workerDescriptions[name];
        return description ? `- ${name}: ${description}` : `- ${name}`;
      })
      .join('\n');

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
    const delegateTool = new FunctionTool({
      name: DELEGATE_TOOL_NAME,
      description: 'Delegate a subtask to a specialist worker agent and return its response.',
      inputSchema: {
        type: 'object',
        properties: {
          worker: {
            type: 'string',
            description: 'Name of the worker agent',
          },
          task: {
            type: 'string',
            description: 'Task description for the worker',
          },
        },
        required: ['worker', 'task'],
      },
      execute: async (raw) => this.executeDelegation(raw),
    });

    this.toolRegistry.register(delegateTool, { onDuplicate: 'overwrite' });
  }

  private async executeDelegation(raw: Record<string, unknown>): Promise<string> {
    if (this.delegationCount >= this.maxDelegations) {
      throw new Error(`Maximum delegations (${this.maxDelegations}) exceeded`);
    }

    const workerName = typeof raw.worker === 'string' ? raw.worker : '';
    const task = typeof raw.task === 'string' ? raw.task : '';

    if (!workerName || !task) {
      throw new Error('delegate requires "worker" and "task" string fields');
    }

    const worker = this.workers[workerName];
    if (!worker) {
      throw new Error(`Unknown worker "${workerName}"`);
    }

    this.delegationCount += 1;

    if (worker instanceof HierarchicalWorkflow) {
      const nested = await worker.run(task);
      this.delegationSteps.push(...nested.steps);
      return nested.finalResult.response;
    }

    const step = await runAgentStep({
      agent: worker,
      agentName: workerName,
      input: task,
      config: this.config,
    });

    this.delegationSteps.push(step);
    return step.result.response;
  }
}

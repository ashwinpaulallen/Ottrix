import { Agent } from '../agent/agent.js';
import { WorkingMemory } from '../memory/working.js';
import { messageToText } from '../memory/tokens.js';
import type { BaseTool } from '../tools/tool.js';
import { ToolRegistry } from '../tools/registry.js';
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
import { runAgentStep, mergeTokenUsage, WorkflowTimeoutError } from './runner.js';
import { createSupervisorThinkingOnStep } from './thinking.js';
import type { AgentResult } from '../types/agent.js';
import type { CompletionProvider, TokenUsage } from '../types/provider.js';

const DEFAULT_MAX_DELEGATION_ROUNDS = 10;
const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_NESTED_DEPTH = 3;

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Options passed to {@link SupervisorWorkflow.run} for nested execution. */
export interface SupervisorRunOptions {
  /** Current nesting depth when invoked as a worker supervisor. @defaultValue 0 */
  nestedDepth?: number;
}

/** A specialist worker agent or nested supervisor workflow. */
export type SupervisorWorker = Agent | SupervisorWorkflow;

/** Record of a single delegation from the supervisor to a worker. */
export interface DelegationRecord {
  worker: string;
  task: string;
  context?: string;
  result: AgentResult;
  duration: number;
  error?: string;
  /** Nested delegations when the worker is another {@link SupervisorWorkflow}. */
  subDelegations?: DelegationRecord[];
}

/** Outcome of a {@link SupervisorWorkflow.run}. */
export interface SupervisorWorkflowResult {
  finalResult: AgentResult;
  delegations: DelegationRecord[];
  totalTokens: TokenUsage;
  duration: number;
}

/** Options for {@link SupervisorWorkflow}. */
export interface SupervisorWorkflowOptions {
  supervisor: Agent;
  workers: Map<string, SupervisorWorker>;
  workerDescriptions?: Map<string, string>;
  maxDelegationRounds?: number;
  workerTimeout?: number;
  maxNestedDepth?: number;
  toolRegistry?: ToolRegistry;
  onDelegation?: (record: DelegationRecord) => void | Promise<void>;
  /**
   * Called when the supervisor emits a thinking step during the run loop.
   * Wire via `onStep: createSupervisorThinkingOnStep(onSupervisorThinking)` on the
   * supervisor {@link Agent} — {@link createSupervisor} does this automatically.
   */
  onSupervisorThinking?: (content: string) => void | Promise<void>;
}

/** Configuration for {@link createSupervisor}. */
export interface CreateSupervisorConfig {
  provider: CompletionProvider;
  systemPrompt?: string;
  workers: Record<
    string,
    {
      provider?: CompletionProvider;
      systemPrompt: string;
      tools?: BaseTool[];
      description?: string;
    }
  >;
  maxRounds?: number;
  workerTimeout?: number;
  synthesizeResults?: boolean;
  maxNestedDepth?: number;
  onDelegation?: (record: DelegationRecord) => void | Promise<void>;
  /**
   * Called when the supervisor emits a thinking step during the run loop (via `onStep`),
   * not after the workflow completes.
   */
  onSupervisorThinking?: (content: string) => void | Promise<void>;
}

/**
 * Supervisor agent workflow that dynamically delegates tasks to specialist workers.
 */
export class SupervisorWorkflow {
  private readonly supervisor: Agent;
  private readonly workers: Map<string, SupervisorWorker>;
  private readonly workerDescriptions: Map<string, string>;
  private readonly maxDelegationRounds: number;
  private readonly workerTimeout: number;
  private readonly maxNestedDepth: number;
  private readonly toolRegistry: ToolRegistry;
  private readonly onDelegation?: (record: DelegationRecord) => void | Promise<void>;
  private readonly onSupervisorThinking?: (content: string) => void | Promise<void>;

  private delegationCount = 0;
  private readonly delegations: DelegationRecord[] = [];
  private readonly workerMemories = new Map<string, WorkingMemory>();
  private nestedDepth = 0;

  constructor(options: SupervisorWorkflowOptions) {
    this.supervisor = options.supervisor;
    this.workers = options.workers;
    this.workerDescriptions = options.workerDescriptions ?? new Map();
    this.maxDelegationRounds = options.maxDelegationRounds ?? DEFAULT_MAX_DELEGATION_ROUNDS;
    this.workerTimeout = options.workerTimeout ?? DEFAULT_WORKER_TIMEOUT_MS;
    this.maxNestedDepth = options.maxNestedDepth ?? DEFAULT_MAX_NESTED_DEPTH;
    this.onDelegation = options.onDelegation;
    this.onSupervisorThinking = options.onSupervisorThinking;

    this.toolRegistry = requireToolRegistry(
      options.toolRegistry,
      options.supervisor.getToolRegistry(),
      'SupervisorWorkflow',
    );
    this.registerDelegateTool();
  }

  getName(): string {
    return this.supervisor.getName();
  }

  async run(input: string, options?: SupervisorRunOptions): Promise<SupervisorWorkflowResult> {
    const started = Date.now();
    this.delegationCount = 0;
    this.delegations.length = 0;
    this.workerMemories.clear();
    this.nestedDepth = options?.nestedDepth ?? 0;

    const supervisorStep = await runAgentStep({
      agent: this.supervisor,
      agentName: this.supervisor.getName(),
      input,
    });

    return {
      finalResult: {
        ...supervisorStep.result,
        metadata: {
          ...supervisorStep.result.metadata,
          delegations: this.delegations.length,
        },
      },
      delegations: [...this.delegations],
      totalTokens: mergeTokenUsage([supervisorStep.result, ...this.delegations.map((d) => d.result)]),
      duration: Date.now() - started,
    };
  }

  static buildWorkerSystemPrompt(
    workers: Map<string, SupervisorWorker>,
    descriptions?: Map<string, string>,
  ): string {
    const lines = buildWorkerRosterLines([...workers.keys()], descriptions);
    return (
      'You have access to these specialist agents:\n' +
      `${lines.join('\n')}\n` +
      `Use the '${DELEGATE_TOOL_NAME}' tool to assign tasks to them.`
    );
  }

  private registerDelegateTool(): void {
    registerDelegateTool(
      this.toolRegistry,
      [...this.workers.keys()],
      (delegateInput) => this.executeDelegation(delegateInput),
      {
        includeContext: true,
        description: 'Delegate a specific task to a specialist worker agent and return its response.',
      },
    );
  }

  private async executeDelegation(input: DelegateToolInput): Promise<string> {
    if (this.delegationCount >= this.maxDelegationRounds) {
      return delegateLimitMessage(this.maxDelegationRounds);
    }

    const worker = this.workers.get(input.worker);
    if (!worker) {
      return unknownWorkerMessage(input.worker, [...this.workers.keys()]);
    }

    this.delegationCount += 1;

    if (worker instanceof SupervisorWorkflow) {
      return this.runNestedSupervisor(worker, input);
    }

    return this.runWorkerAgent(worker, input);
  }

  private async runNestedSupervisor(
    worker: SupervisorWorkflow,
    input: DelegateToolInput,
  ): Promise<string> {
    const { worker: workerName, task, context } = input;

    if (this.nestedDepth >= this.maxNestedDepth) {
      const message =
        `Maximum nested delegation depth (${this.maxNestedDepth}) exceeded for worker "${workerName}". ` +
        'Try a different approach.';
      await this.recordDelegation({
        worker: workerName,
        task,
        context,
        result: errorAgentResult(message),
        duration: 0,
        error: message,
      });
      return message;
    }

    const nestedInput = context ? `${context}\n\n${task}` : task;
    const started = Date.now();

    try {
      const nested = await worker.run(nestedInput, { nestedDepth: this.nestedDepth + 1 });

      await this.recordDelegation({
        worker: workerName,
        task,
        context,
        result: nested.finalResult,
        duration: Date.now() - started,
        subDelegations: nested.delegations,
      });

      return nested.finalResult.response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordDelegation({
        worker: workerName,
        task,
        context,
        result: errorAgentResult(message),
        duration: Date.now() - started,
        error: message,
      });
      return workerFailureMessage(workerName, message);
    }
  }

  private async runWorkerAgent(worker: Agent, input: DelegateToolInput): Promise<string> {
    const { worker: workerName, task, context } = input;
    const memory = this.getWorkerMemory(workerName);
    const workerInput = buildWorkerInput(memory, task, context);
    const started = Date.now();

    try {
      const step = await runAgentStep({
        agent: worker,
        agentName: workerName,
        input: workerInput,
        timeoutMs: this.workerTimeout,
      });

      memory.addMessage({ role: 'user', content: workerInput });
      memory.addMessage({ role: 'assistant', content: step.result.response });

      await this.recordDelegation({
        worker: workerName,
        task,
        context,
        result: step.result,
        duration: step.duration,
      });

      return step.result.response;
    } catch (error) {
      const message =
        error instanceof WorkflowTimeoutError
          ? `${workerName} timed out after ${this.workerTimeout}ms`
          : error instanceof Error
            ? error.message
            : String(error);

      await this.recordDelegation({
        worker: workerName,
        task,
        context,
        result: errorAgentResult(message),
        duration: Date.now() - started,
        error: message,
      });

      return workerFailureMessage(workerName, message);
    }
  }

  private getWorkerMemory(workerName: string): WorkingMemory {
    let memory = this.workerMemories.get(workerName);
    if (!memory) {
      memory = new WorkingMemory();
      this.workerMemories.set(workerName, memory);
    }
    return memory;
  }

  private async recordDelegation(record: DelegationRecord): Promise<void> {
    this.delegations.push(record);
    await this.onDelegation?.(record);
  }
}

export function createSupervisor(config: CreateSupervisorConfig): SupervisorWorkflow {
  const registry = new ToolRegistry();
  const workers = new Map<string, Agent>();
  const workerDescriptions = new Map<string, string>();

  for (const [name, workerConfig] of Object.entries(config.workers)) {
    const workerRegistry = new ToolRegistry();
    for (const tool of workerConfig.tools ?? []) {
      workerRegistry.register(tool);
    }

    workers.set(
      name,
      new Agent({
        name,
        provider: workerConfig.provider ?? config.provider,
        systemPrompt: workerConfig.systemPrompt,
        toolRegistry: workerRegistry,
      }),
    );

    workerDescriptions.set(
      name,
      workerConfig.description ?? summarizeSystemPrompt(workerConfig.systemPrompt),
    );
  }

  const workerPrompt = SupervisorWorkflow.buildWorkerSystemPrompt(workers, workerDescriptions);
  const synthesisInstruction =
    config.synthesizeResults === false
      ? ''
      : '\n\nAfter receiving results from workers via the delegate tool, synthesize them into a final comprehensive answer for the user.';

  const systemPrompt = [config.systemPrompt, workerPrompt].filter(Boolean).join('\n\n') + synthesisInstruction;

  const supervisor = new Agent({
    name: 'supervisor',
    provider: config.provider,
    systemPrompt,
    toolRegistry: registry,
    onStep: createSupervisorThinkingOnStep(config.onSupervisorThinking),
  });

  return new SupervisorWorkflow({
    supervisor,
    workers,
    workerDescriptions,
    toolRegistry: registry,
    maxDelegationRounds: config.maxRounds,
    workerTimeout: config.workerTimeout,
    maxNestedDepth: config.maxNestedDepth,
    onDelegation: config.onDelegation,
    onSupervisorThinking: config.onSupervisorThinking,
  });
}

function buildWorkerInput(memory: WorkingMemory, task: string, context?: string): string {
  const parts: string[] = [];
  const history = memory.getMessages();

  if (history.length > 0) {
    parts.push('Previous conversation:');
    for (const message of history) {
      parts.push(`${message.role}: ${messageToText(message)}`);
    }
    parts.push('');
  }

  if (context) {
    parts.push(`Context:\n${context}`);
    parts.push('');
  }

  parts.push(`Task:\n${task}`);
  return parts.join('\n');
}

function summarizeSystemPrompt(systemPrompt: string): string {
  const firstLine = systemPrompt.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? systemPrompt;
}

function errorAgentResult(message: string): AgentResult {
  return {
    response: '',
    steps: [],
    totalTokens: EMPTY_USAGE,
    metadata: { stopReason: 'error', warning: message },
  };
}

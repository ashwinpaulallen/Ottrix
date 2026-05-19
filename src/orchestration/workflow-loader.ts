import { readFile } from 'node:fs/promises';
import { Agent } from '../agent/agent.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ToolRegistry } from '../tools/registry.js';
import type { WorkflowConfig, WorkflowResult } from './types.js';
import { HierarchicalWorkflow } from './hierarchical.js';
import { ParallelWorkflow } from './parallel.js';
import { RouterWorkflow, type WorkflowRouterFn } from './router.js';
import { SequentialWorkflow, type SequentialWorkflowStep } from './sequential.js';
import type {
  RouterRule,
  WorkflowAgentDefinition,
  WorkflowDefinition,
  WorkflowHierarchicalDef,
  WorkflowParallelDef,
  WorkflowRouterDef,
  WorkflowStepDef,
  WorkflowStructureDescription,
  WorkflowTopologyDef,
} from './workflow-definition.js';
import { mergeTokenUsage, runAgentStep } from './runner.js';
import { parseWorkflowFile } from './yaml-parse.js';

/** Built workflow instance (runnable). */
export type BuiltWorkflow =
  | SequentialWorkflow
  | ParallelWorkflow
  | RouterWorkflow
  | HierarchicalWorkflow
  | ParallelThenWorkflow;

/**
 * Parallel execution followed by an optional synthesis step (sequential wrapper).
 */
export class ParallelThenWorkflow {
  private readonly parallel: ParallelWorkflow;
  private readonly thenAgent: Agent;
  private readonly thenInputTemplate: string;
  private readonly thenAgentName: string;
  private readonly config?: WorkflowConfig;

  constructor(options: {
    parallel: ParallelWorkflow;
    thenAgent: Agent;
    thenAgentName: string;
    inputTemplate?: string;
    config?: WorkflowConfig;
  }) {
    this.parallel = options.parallel;
    this.thenAgent = options.thenAgent;
    this.thenAgentName = options.thenAgentName;
    this.config = options.config;
    this.thenInputTemplate =
      options.inputTemplate ?? 'Synthesize the following perspectives:\n\n{{previous}}';
  }

  /** Run parallel branches, then a synthesis agent on the merged output. */
  async run(input: string): Promise<WorkflowResult> {
    const parallelResult = await this.parallel.run(input);
    const synthInput = renderTemplate(this.thenInputTemplate, {
      input,
      previous: parallelResult.finalResult.response,
    });

    const step = await runAgentStep({
      agent: this.thenAgent,
      agentName: this.thenAgentName,
      input: synthInput,
      config: this.config,
    });

    const allSteps = [...parallelResult.steps, step];

    return {
      finalResult: {
        ...step.result,
        totalTokens: mergeTokenUsage(allSteps.map((s) => s.result)),
        metadata: {
          ...step.result.metadata,
          parallelBranches: parallelResult.steps.length,
          workflowSteps: allSteps.length,
        },
      },
      steps: allSteps,
      duration: parallelResult.duration + step.duration,
    };
  }
}

/** Options for {@link WorkflowLoader}. */
export interface WorkflowLoaderOptions {
  /** Registry used to resolve `agents.*.provider` names. */
  providers: ProviderRegistry;
  /** Optional global tool registry for resolving `agents.*.tools`. */
  tools?: ToolRegistry;
}

/** Result of loading a workflow definition. */
export class LoadedWorkflow {
  /** Parsed and validated definition. */
  readonly definition: WorkflowDefinition;
  /** Resolved agent instances keyed by name. */
  readonly agents: Record<string, Agent>;
  /** Constructed workflow runner. */
  readonly workflow: BuiltWorkflow;

  constructor(definition: WorkflowDefinition, agents: Record<string, Agent>, workflow: BuiltWorkflow) {
    this.definition = definition;
    this.agents = agents;
    this.workflow = workflow;
  }

  /** Serializable structure for inspection and tests. */
  describe(): WorkflowStructureDescription {
    return describeWorkflow(this.definition);
  }
}

/**
 * Loads {@link WorkflowDefinition} files and builds runnable workflows.
 */
export class WorkflowLoader {
  private readonly providers: ProviderRegistry;
  private readonly tools?: ToolRegistry;

  /**
   * @param options - Provider and optional tool registries.
   */
  constructor(options: WorkflowLoaderOptions) {
    this.providers = options.providers;
    this.tools = options.tools;
  }

  /**
   * Load a workflow from a `.yaml`, `.yml`, or `.json` file.
   */
  async loadFromFile(filePath: string): Promise<LoadedWorkflow> {
    const content = await readFile(filePath, 'utf8');
    const raw = await parseWorkflowFile(content, filePath);
    const definition = normalizeWorkflowDefinition(raw);
    return this.loadFromObject(definition);
  }

  /**
   * Build a workflow from an in-memory definition.
   */
  loadFromObject(definition: WorkflowDefinition): LoadedWorkflow {
    validateWorkflowDefinition(definition);
    const agents = this.resolveAgents(definition);
    const config = this.buildWorkflowConfig(definition);
    const workflow = this.buildWorkflow(definition, agents, config);
    return new LoadedWorkflow(definition, agents, workflow);
  }

  private resolveAgents(definition: WorkflowDefinition): Record<string, Agent> {
    const agents: Record<string, Agent> = {};
    const hierarchicalManager =
      definition.workflow.type === 'hierarchical'
        ? definition.workflow.manager
        : undefined;

    for (const [name, agentDef] of Object.entries(definition.agents)) {
      const provider = this.providers.get(agentDef.provider);
      let toolRegistry = this.buildAgentToolRegistry(agentDef.tools);

      if (hierarchicalManager === name && !toolRegistry) {
        toolRegistry = new ToolRegistry();
      }

      agents[name] = new Agent({
        name,
        provider,
        systemPrompt: agentDef.systemPrompt,
        defaultModel: agentDef.model,
        maxSteps: agentDef.maxSteps,
        toolRegistry,
      });
    }

    return agents;
  }

  private buildAgentToolRegistry(toolNames?: string[]): ToolRegistry | undefined {
    if (!toolNames || toolNames.length === 0) {
      return undefined;
    }

    if (!this.tools) {
      throw new Error(
        `Workflow references tools [${toolNames.join(', ')}] but no ToolRegistry was provided to WorkflowLoader`,
      );
    }

    const registry = new ToolRegistry();
    for (const toolName of toolNames) {
      const tool = this.tools.get(toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" is not registered in WorkflowLoader tools registry`);
      }
      registry.register(tool);
    }
    return registry;
  }

  private buildWorkflowConfig(definition: WorkflowDefinition): WorkflowConfig | undefined {
    if (!definition.options?.timeout) {
      return undefined;
    }
    return { timeout: definition.options.timeout };
  }

  private buildWorkflow(
    definition: WorkflowDefinition,
    agents: Record<string, Agent>,
    config?: WorkflowConfig,
  ): BuiltWorkflow {
    const topology = definition.workflow;

    switch (topology.type) {
      case 'sequential':
        return this.buildSequential(topology.steps, agents, config);
      case 'parallel':
        return this.buildParallel(topology, agents, config);
      case 'router':
        return this.buildRouter(topology.router, agents, config);
      case 'hierarchical':
        return this.buildHierarchical(topology, agents, config);
      default:
        throw new Error('Unsupported workflow type');
    }
  }

  private buildSequential(
    steps: WorkflowStepDef[],
    agents: Record<string, Agent>,
    config?: WorkflowConfig,
  ): SequentialWorkflow {
    const sequentialSteps: SequentialWorkflowStep[] = steps.map((step) => ({
      agent: agents[step.agent],
      name: step.agent,
      goal: step.goal,
      inputMapper: step.inputTemplate
        ? (context, lastResult) =>
            renderTemplate(step.inputTemplate!, {
              input: context.originalInput,
              previous: lastResult?.response,
            })
        : undefined,
    }));

    return new SequentialWorkflow(sequentialSteps, config);
  }

  private buildParallel(
    parallel: WorkflowParallelDef & { type: 'parallel' },
    agents: Record<string, Agent>,
    config?: WorkflowConfig,
  ): BuiltWorkflow {
    const parallelWorkflow = new ParallelWorkflow({
      branches: parallel.agents.map((name) => ({ agent: agents[name], name })),
      concurrency: parallel.concurrency,
      config,
    });

    if (!parallel.then) {
      return parallelWorkflow;
    }

    return new ParallelThenWorkflow({
      parallel: parallelWorkflow,
      thenAgent: agents[parallel.then.agent],
      thenAgentName: parallel.then.agent,
      inputTemplate: parallel.then.inputTemplate,
      config,
    });
  }

  private buildRouter(
    router: WorkflowRouterDef,
    agents: Record<string, Agent>,
    config?: WorkflowConfig,
  ): RouterWorkflow {
    const route = this.createRouterFn(router, agents);
    const agentMap =
      router.type === 'rules'
        ? this.collectRulesRouterAgents(router, agents)
        : { ...agents };
    const fallback = router.fallback ? agents[router.fallback] : undefined;

    return new RouterWorkflow({
      route,
      agents: agentMap,
      fallbackAgent: fallback,
      config,
    });
  }

  private collectRulesRouterAgents(
    router: WorkflowRouterDef,
    agents: Record<string, Agent>,
  ): Record<string, Agent> {
    const map: Record<string, Agent> = {};
    for (const rule of router.rules ?? []) {
      map[rule.agent] = agents[rule.agent]!;
    }
    if (router.fallback) {
      map[router.fallback] = agents[router.fallback]!;
    }
    return map;
  }

  private createRouterFn(
    router: WorkflowRouterDef,
    agents: Record<string, Agent>,
  ): WorkflowRouterFn {
    if (router.type === 'rules') {
      const rules = router.rules ?? [];
      return (input: string) => {
        for (const rule of rules) {
          if (matchesRule(input, rule)) {
            return rule.agent;
          }
        }
        if (router.fallback) {
          return router.fallback;
        }
        throw new Error('RouterWorkflow: no rule matched and no fallback configured');
      };
    }

    const llmAgentName = router.llmAgent ?? router.fallback;
    if (!llmAgentName || !agents[llmAgentName]) {
      throw new Error('LLM router requires llmAgent referencing a defined agent');
    }

    const llmAgent = agents[llmAgentName];
    const agentKeys = Object.keys(agents).join(', ');

    return async (input: string) => {
      const result = await llmAgent.run(
        `Route this request to exactly one agent key.\n` +
          `Available agents: ${agentKeys}\n\n` +
          `Request:\n${input}\n\n` +
          `Reply with only the agent key.`,
      );
      const key = result.response.trim().replace(/^["'`]+|["'`]+$/g, '').split(/\s+/)[0] ?? '';
      if (agents[key]) {
        return key;
      }
      if (router.fallback && agents[router.fallback]) {
        return router.fallback;
      }
      throw new Error(`LLM router returned unknown agent key "${key}"`);
    };
  }

  private buildHierarchical(
    topology: WorkflowHierarchicalDef & { type: 'hierarchical' },
    agents: Record<string, Agent>,
    config?: WorkflowConfig,
  ): HierarchicalWorkflow {
    const manager = agents[topology.manager];
    const workers: Record<string, Agent> = {};

    for (const workerName of topology.workers) {
      if (workerName === topology.manager) {
        throw new Error(
          `Hierarchical workflow: worker "${workerName}" cannot be the same as manager`,
        );
      }
      workers[workerName] = agents[workerName]!;
    }

    const toolRegistry = manager.getToolRegistry();
    if (!toolRegistry) {
      throw new Error(
        `Hierarchical workflow manager "${topology.manager}" requires a ToolRegistry ` +
          '(set tools on the manager agent or use an empty tools list in the workflow definition)',
      );
    }

    return new HierarchicalWorkflow({
      manager,
      workers,
      toolRegistry,
      maxDelegations: topology.maxDelegations,
      config,
    });
  }
}

/** Validate a {@link WorkflowDefinition} and throw on structural errors. */
export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (!definition.name?.trim()) {
    throw new Error('Workflow definition requires a non-empty name');
  }

  if (!definition.agents || Object.keys(definition.agents).length === 0) {
    throw new Error('Workflow definition requires at least one agent');
  }

  const agentNames = new Set(Object.keys(definition.agents));

  const ensureAgent = (name: string, context: string): void => {
    if (!agentNames.has(name)) {
      throw new Error(`${context}: unknown agent "${name}"`);
    }
  };

  const topology = definition.workflow;

  switch (topology.type) {
    case 'sequential': {
      if (!topology.steps || topology.steps.length === 0) {
        throw new Error('Sequential workflow requires at least one step');
      }
      for (const step of topology.steps) {
        ensureAgent(step.agent, 'Sequential step');
      }
      detectSequentialCycles(topology.steps);
      break;
    }
    case 'parallel': {
      if (!topology.agents || topology.agents.length === 0) {
        throw new Error('Parallel workflow requires at least one agent');
      }
      const seenParallel = new Set<string>();
      for (const name of topology.agents) {
        ensureAgent(name, 'Parallel agent');
        if (seenParallel.has(name)) {
          throw new Error(`Parallel workflow: duplicate agent "${name}"`);
        }
        seenParallel.add(name);
      }
      if (topology.then) {
        ensureAgent(topology.then.agent, 'Parallel then');
      }
      break;
    }
    case 'router': {
      const router = topology.router;
      if (router.type === 'rules') {
        const rules = router.rules ?? [];
        if (rules.length === 0 && !router.fallback) {
          throw new Error(
            'Rules router requires at least one rule or a fallback agent',
          );
        }
        for (const rule of rules) {
          ensureAgent(rule.agent, 'Router rule');
          validateRouterPattern(rule.pattern);
        }
      } else if (!router.llmAgent) {
        throw new Error('LLM router requires llmAgent referencing a defined agent');
      }
      if (router.fallback) {
        ensureAgent(router.fallback, 'Router fallback');
      }
      if (router.llmAgent) {
        ensureAgent(router.llmAgent, 'Router llmAgent');
      }
      break;
    }
    case 'hierarchical': {
      ensureAgent(topology.manager, 'Hierarchical manager');
      if (!topology.workers || topology.workers.length === 0) {
        throw new Error('Hierarchical workflow requires at least one worker');
      }
      for (const worker of topology.workers) {
        ensureAgent(worker, 'Hierarchical worker');
      }
      if (topology.workers.includes(topology.manager)) {
        throw new Error('Hierarchical workflow: manager cannot also be a worker');
      }
      break;
    }
    default:
      throw new Error('Unknown workflow type');
  }
}

/** Produce a serializable description of a workflow definition. */
export function describeWorkflow(definition: WorkflowDefinition): WorkflowStructureDescription {
  const topology = definition.workflow;
  const base: WorkflowStructureDescription = {
    name: definition.name,
    description: definition.description,
    type: topology.type,
    agentNames: Object.keys(definition.agents),
  };

  if (topology.type === 'sequential') {
    return { ...base, sequential: topology.steps };
  }

  if (topology.type === 'parallel') {
    const type = topology.then ? 'parallel-then' : 'parallel';
    return {
      ...base,
      type,
      parallel: {
        agents: topology.agents,
        then: topology.then,
        concurrency: topology.concurrency,
      },
    };
  }

  if (topology.type === 'router') {
    return { ...base, router: topology.router };
  }

  return {
    ...base,
    hierarchical: {
      manager: topology.manager,
      workers: topology.workers,
      maxDelegations: topology.maxDelegations,
    },
  };
}

/** Coerce parsed YAML/JSON into a {@link WorkflowDefinition}. */
export function normalizeWorkflowDefinition(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Workflow definition must be an object');
  }

  const record = raw as Record<string, unknown>;
  const name = stringField(record, 'name');
  const description = stringField(record, 'description', '');
  const agentsRaw = record.agents;

  if (!agentsRaw || typeof agentsRaw !== 'object') {
    throw new Error('Workflow definition requires an agents map');
  }

  const agents: Record<string, WorkflowAgentDefinition> = {};
  for (const [agentName, agentValue] of Object.entries(agentsRaw as Record<string, unknown>)) {
    agents[agentName] = normalizeAgentDefinition(agentValue);
  }

  const workflow = normalizeTopology(record.workflow);

  const options =
    record.options && typeof record.options === 'object'
      ? {
          timeout:
            typeof (record.options as Record<string, unknown>).timeout === 'number'
              ? ((record.options as Record<string, unknown>).timeout as number)
              : undefined,
        }
      : undefined;

  return { name, description, agents, workflow, options };
}

function normalizeAgentDefinition(raw: unknown): WorkflowAgentDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Agent definition must be an object');
  }
  const record = raw as Record<string, unknown>;
  return {
    provider: stringField(record, 'provider'),
    model: optionalString(record.model),
    systemPrompt: stringField(record, 'systemPrompt'),
    tools: optionalStringArray(record.tools),
    maxSteps: typeof record.maxSteps === 'number' ? record.maxSteps : undefined,
  };
}

function normalizeTopology(raw: unknown): WorkflowTopologyDef {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Workflow definition requires a workflow object');
  }

  const record = raw as Record<string, unknown>;
  const type = stringField(record, 'type');

  switch (type) {
    case 'sequential':
      return {
        type: 'sequential',
        steps: normalizeStepArray(record.steps),
      };
    case 'parallel':
      return {
        type: 'parallel',
        agents: stringArrayField(record, 'agents'),
        concurrency: typeof record.concurrency === 'number' ? record.concurrency : undefined,
        then: normalizeThen(record.then),
      };
    case 'router':
      return {
        type: 'router',
        router: normalizeRouter(record.router),
      };
    case 'hierarchical':
      return {
        type: 'hierarchical',
        manager: stringField(record, 'manager'),
        workers: stringArrayField(record, 'workers'),
        maxDelegations:
          typeof record.maxDelegations === 'number' ? record.maxDelegations : undefined,
      };
    default:
      throw new Error(`Unsupported workflow type "${type}"`);
  }
}

function normalizeStepArray(raw: unknown): WorkflowStepDef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Sequential workflow requires a non-empty steps array');
  }

  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`steps[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    return {
      agent: stringField(record, 'agent'),
      inputTemplate: optionalString(record.inputTemplate),
      goal: optionalString(record.goal),
    };
  });
}

function normalizeRouter(raw: unknown): WorkflowRouterDef {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Router workflow requires a router object');
  }
  const record = raw as Record<string, unknown>;
  const type = stringField(record, 'type');
  if (type !== 'rules' && type !== 'llm') {
    throw new Error('router.type must be "rules" or "llm"');
  }

  const rulesRaw = record.rules;
  const rules: RouterRule[] | undefined = Array.isArray(rulesRaw)
    ? rulesRaw.map((rule, index) => {
        if (!rule || typeof rule !== 'object') {
          throw new Error(`router.rules[${index}] must be an object`);
        }
        const r = rule as Record<string, unknown>;
        return {
          pattern: stringField(r, 'pattern'),
          agent: stringField(r, 'agent'),
        };
      })
    : undefined;

  return {
    type,
    rules,
    fallback: optionalString(record.fallback),
    llmAgent: optionalString(record.llmAgent),
  };
}

function normalizeThen(raw: unknown): WorkflowParallelDef['then'] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object') {
    throw new Error('parallel.then must be an object');
  }
  const record = raw as Record<string, unknown>;
  return {
    agent: stringField(record, 'agent'),
    inputTemplate: optionalString(record.inputTemplate),
  };
}

function stringField(record: Record<string, unknown>, key: string, fallback?: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required field "${key}"`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty array`);
  }
  return value.map((item) => (typeof item === 'string' ? item : String(item)));
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item));
}

function renderTemplate(
  template: string,
  context: { input: string; previous?: string },
): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, context.input)
    .replace(/\{\{\s*previous\s*\}\}/g, context.previous ?? '');
}

function validateRouterPattern(pattern: string): void {
  if (!pattern.startsWith('/') || pattern.lastIndexOf('/') <= 0) {
    return;
  }
  const last = pattern.lastIndexOf('/');
  const body = pattern.slice(1, last);
  const flags = pattern.slice(last + 1);
  try {
    new RegExp(body, flags);
  } catch {
    throw new Error(`Router rule has invalid regex pattern "${pattern}"`);
  }
}

function matchesRule(input: string, rule: RouterRule): boolean {
  const pattern = rule.pattern;
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const last = pattern.lastIndexOf('/');
    const body = pattern.slice(1, last);
    const flags = pattern.slice(last + 1);
    try {
      return new RegExp(body, flags).test(input);
    } catch {
      return false;
    }
  }
  return input.toLowerCase().includes(pattern.toLowerCase());
}

function detectSequentialCycles(steps: WorkflowStepDef[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.agent)) {
      throw new Error(
        `Sequential workflow: duplicate agent "${step.agent}" may cause circular hand-offs`,
      );
    }
    seen.add(step.agent);
  }
}

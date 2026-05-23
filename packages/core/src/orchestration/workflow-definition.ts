/** Agent configuration within a {@link WorkflowDefinition}. */
export interface WorkflowAgentDefinition {
  /** Registered provider name (see {@link import('../providers/registry.js').ProviderRegistry}). */
  provider: string;
  /** Optional model override when supported by the provider. */
  model?: string;
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Registered tool names to attach to this agent. */
  tools?: string[];
  /** Maximum ReAct steps. */
  maxSteps?: number;
}

/** Sequential workflow step reference. */
export interface WorkflowStepDef {
  /** Agent name defined in `agents`. */
  agent: string;
  /**
   * Input template. Supports `{{input}}` (original) and `{{previous}}` (prior response).
   */
  inputTemplate?: string;
  /** Goal override for reflector early-termination checks. */
  goal?: string;
}

/** Rule-based router pattern. */
export interface RouterRule {
  /** Substring or regex pattern (regex when wrapped in `/.../`). */
  pattern: string;
  /** Target agent name. */
  agent: string;
}

/** Router workflow configuration. */
export interface WorkflowRouterDef {
  /** Rule-based keyword routing or LLM classification. */
  type: 'llm' | 'rules';
  /** Rules evaluated in order for `type: rules`. */
  rules?: RouterRule[];
  /** Fallback agent when no rule matches. */
  fallback?: string;
  /** LLM router agent name (must exist in `agents`) for `type: llm`. */
  llmAgent?: string;
}

/** Parallel workflow configuration. */
export interface WorkflowParallelDef {
  /** Agent names to run concurrently. */
  agents: string[];
  /** Optional agent run after parallel merge (wraps as sequential). */
  then?: {
    agent: string;
    inputTemplate?: string;
  };
  /** Concurrency limit. */
  concurrency?: number;
}

/** Hierarchical workflow configuration. */
export interface WorkflowHierarchicalDef {
  /** Manager agent name. */
  manager: string;
  /** Worker agent names. */
  workers: string[];
  /** Maximum delegate calls. */
  maxDelegations?: number;
}

/** Supervisor workflow configuration. */
export interface WorkflowSupervisorDef {
  /** Supervisor agent name. */
  supervisor: string;
  /** Worker agent names. */
  workers: string[];
  /** Optional worker descriptions injected into the supervisor system prompt. */
  workerDescriptions?: Record<string, string>;
  /** Maximum delegate tool invocations. */
  maxRounds?: number;
  /** Per-worker timeout in milliseconds. */
  workerTimeout?: number;
  /** Maximum nested supervisor depth. */
  maxNestedDepth?: number;
  /** Whether the supervisor synthesizes worker outputs. @defaultValue true */
  synthesizeResults?: boolean;
}

/** DAG workflow step referencing a defined agent. */
export interface WorkflowDagStepDef {
  /** Unique step ID within the DAG. */
  id: string;
  /** Agent name defined in `agents`. */
  agent: string;
  /** Optional display name override. */
  name?: string;
  /** IDs of steps that must complete before this step. */
  dependencies?: string[];
  /** Pause for human input before this step runs. */
  suspend?: boolean;
  /** Retry count after the first failure. */
  retries?: number;
  /** Step timeout in milliseconds. */
  timeout?: number;
  /**
   * Input template for dependency outputs. Supports `{{input}}` and `{{depId}}`
   * placeholders for each dependency step ID.
   */
  inputTemplate?: string;
}

/** DAG workflow configuration. */
export interface WorkflowDagDef {
  /** DAG steps referencing agents. */
  steps: WorkflowDagStepDef[];
  /** Maximum concurrent step executions. */
  maxConcurrency?: number;
}

/** Workflow topology configuration. */
export type WorkflowTopologyDef =
  | {
      type: 'sequential';
      steps: WorkflowStepDef[];
    }
  | ({
      type: 'parallel';
    } & WorkflowParallelDef)
  | {
      type: 'router';
      router: WorkflowRouterDef;
    }
  | ({
      type: 'hierarchical';
    } & WorkflowHierarchicalDef)
  | ({
      type: 'supervisor';
    } & WorkflowSupervisorDef)
  | ({
      type: 'dag';
    } & WorkflowDagDef);

/** Declarative multi-agent workflow configuration (YAML/JSON). */
export interface WorkflowDefinition {
  /** Workflow identifier. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Agent definitions keyed by name. */
  agents: Record<string, WorkflowAgentDefinition>;
  /** Workflow topology. */
  workflow: WorkflowTopologyDef;
  /** Optional shared workflow runtime options. */
  options?: {
    timeout?: number;
  };
}

/** Serializable plan returned by {@link import('./workflow-loader.js').LoadedWorkflow.describe}. */
export interface WorkflowStructureDescription {
  name: string;
  description: string;
  type: 'sequential' | 'parallel' | 'router' | 'hierarchical' | 'supervisor' | 'dag' | 'parallel-then';
  agentNames: string[];
  sequential?: WorkflowStepDef[];
  parallel?: {
    agents: string[];
    then?: { agent: string; inputTemplate?: string };
    concurrency?: number;
  };
  router?: WorkflowRouterDef;
  hierarchical?: WorkflowHierarchicalDef;
  supervisor?: WorkflowSupervisorDef;
  dag?: WorkflowDagDef;
}

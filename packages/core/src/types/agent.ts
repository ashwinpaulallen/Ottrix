import type { TokenUsage } from './provider.js';
import type { CompletionProvider } from './provider.js';
import type { ToolDefinition, ToolExecuteOptions, ToolExecutor, ToolResult } from './tools.js';
import type { MemoryProvider } from './memory.js';
import type { GuardrailConfig } from './guardrails.js';

/**
 * Minimal tool registry surface used by the agent loop.
 *
 * Implemented by {@link import('../tools/registry.js').ToolRegistry}.
 */
export interface AgentToolRegistry {
  /** Tool definitions exposed to the model. */
  list(): ToolDefinition[];
  /** Execute a tool by name with validated input. */
  execute(
    name: string,
    input: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<ToolResult>;
}

/** How the agent should proceed after {@link AgentConfig.onError}. */
export type AgentErrorAction = 'retry' | 'skip' | 'abort';

/** Why an agent run stopped. */
export type AgentStopReason =
  | 'completed'
  | 'max_steps'
  | 'token_budget'
  | 'cost_budget'
  | 'guardrail'
  | 'tool_blocked'
  | 'error'
  | 'aborted';

/**
 * Streaming event emitted by {@link import('../agent/agent.js').Agent.stream}.
 */
export type AgentEvent =
  | { type: 'thinking'; data: unknown }
  | { type: 'text'; data: unknown }
  | { type: 'tool_call'; data: unknown }
  | { type: 'tool_result'; data: unknown }
  | { type: 'tool_denied'; data: unknown }
  | { type: 'done'; data: unknown }
  | { type: 'evaluation_start'; data: { refinement: number } }
  | {
      type: 'evaluation_result';
      data: import('../agent/evaluation/types.js').SufficiencyResult & { durationMs: number };
    }
  | {
      type: 'refinement_start';
      data: { missingAspects: string[]; suggestedAction: string };
    }
  | { type: 'evaluation_skipped'; data: { reason: string } }
  | { type: 'max_refinements_reached'; data: { refinements: number } };

/**
 * Discriminated step types recorded during an agent run.
 */
export type AgentStepType = 'thinking' | 'tool_call' | 'tool_result' | 'response';

/**
 * A single observable step in an agent execution trace.
 *
 * @typeParam TContent - Payload shape for the step's `content` field.
 */
export interface AgentStep<TContent = unknown> {
  /** Kind of step for UI, logging, and guardrails. */
  type: AgentStepType;
  /** Step-specific payload (thought text, tool I/O, final answer, etc.). */
  content: TContent;
  /** Unix epoch milliseconds when the step was recorded. */
  timestamp: number;
  /** Token usage attributed to this step, if available. */
  tokenUsage?: TokenUsage;
  /** Self-evaluation recorded after this step (typically a final text response). */
  evaluation?: import('../agent/evaluation/types.js').EvaluationRecord;
}

/**
 * Configuration for constructing and running an agent.
 *
 * @typeParam TModel - Model identifier union supported by the configured provider.
 * @typeParam TToolOutput - Union of tool output types when using typed executors.
 */
export interface AgentConfig<
  TModel extends string = string,
  TToolOutput = unknown,
> {
  /** Human-readable agent name for logging and telemetry. */
  name: string;
  /** LLM backend used for reasoning and tool selection. */
  provider: CompletionProvider<TModel>;
  /**
   * Tool registry for the ReAct loop. Prefer this over `tools` when using
   * {@link import('../tools/registry.js').ToolRegistry} or {@link import('../tools/tool.js').BaseTool}.
   */
  toolRegistry?: AgentToolRegistry;
  /** @deprecated Prefer {@link toolRegistry}. Legacy flat executor list (requires paired definitions). */
  tools?: ToolExecutor<Record<string, unknown>, TToolOutput>[];
  /** Default system instructions for the agent. */
  systemPrompt?: string;
  /** Default model identifier forwarded to the provider on each completion. */
  defaultModel?: TModel;
  /** Optional memory backend for retrieval-augmented turns. */
  memory?: MemoryProvider;
  /**
   * Optional observational memory for automatic user fact extraction and
   * system-prompt personalization.
   */
  observationalMemory?: import('../memory/observational.js').ObservationalMemory;
  /** Safety, budget, and validation policies. */
  guardrails?: GuardrailConfig;
  /**
   * Composable middleware for LLM and tool guardrails.
   * Use {@link import('../guardrails/index.js').createGuardrails} to build a chain.
   */
  guardrailMiddleware?: import('../guardrails/middleware.js').GuardrailMiddleware;
  /** Maximum ReAct / tool-loop iterations before forced stop. */
  maxSteps?: number;
  /** Cumulative token budget across the entire run. */
  maxTokenBudget?: number;
  /** Callback invoked after each recorded {@link AgentStep}. May return a Promise to defer the next loop iteration. */
  onStep?: (step: AgentStep) => void | Promise<void>;
  /**
   * Called before a tool executes. Return `false` to block the call.
   */
  onToolCall?: (name: string, input: unknown) => boolean | void | Promise<boolean | void>;
  /** Optional hook for streaming-style events during {@link import('../agent/agent.js').Agent.run}. */
  onAgentEvent?: (event: AgentEvent) => void;
  /**
   * Called when a step fails. Return an action to retry, skip, or abort the run.
   */
  onError?: (
    error: Error,
    step: AgentStep,
  ) => AgentErrorAction | void | Promise<AgentErrorAction | void>;
  /**
   * Estimated context window in tokens. When exceeded, older messages are summarized.
   * @defaultValue 128000
   */
  contextLimitTokens?: number;
  /**
   * Number of recent conversation messages to keep verbatim during summarization.
   * @defaultValue 6
   */
  keepRecentMessages?: number;
  /**
   * Optional task planner. When set, the agent plans before the ReAct loop and
   * injects the plan into the initial user message.
   */
  planner?: import('../agent/planner.js').Planner;
  /**
   * Optional reflector for meta-cognitive evaluation after steps and at completion.
   */
  reflector?: import('../agent/reflector.js').Reflector;
  /**
   * Enable iterative self-evaluation to improve response quality.
   * After each final response, the agent evaluates whether it fully
   * addressed the original request. If not, it refines up to maxRefinements times.
   *
   * Cost consideration: evaluation adds ~1 LLM call per refinement.
   * Use a cheap model (e.g. 'claude-haiku-3.5') via evaluation.model.
   *
   * @example
   * evaluation: {
   *   enabled: true,
   *   threshold: 0.8,          // confidence threshold to trigger refinement
   *   maxRefinements: 2,        // max refinement attempts
   *   model: 'claude-haiku-3.5', // cheap model for evaluation
   *   criteria: [               // optional: domain-specific quality criteria
   *     'Answers all parts of the question',
   *     'Includes code examples for technical questions',
   *   ],
   * }
   */
  evaluation?: import('../agent/evaluation/types.js').EvaluationConfig;
  /**
   * Optional provider used only for self-evaluation calls.
   * When unset, evaluation uses the agent's main {@link provider}.
   * {@link import('../factory.js').createAgent} sets this when `evaluation.model`
   * differs from the main agent model (same credentials, cheaper model).
   */
  evaluationProvider?: CompletionProvider;
  /**
   * Shared telemetry instance for spans and metrics.
   * Falls back to the global instance from {@link import('../observability/global.js').getTelemetry}.
   */
  telemetry?: import('../observability/telemetry.js').Telemetry;
  /**
   * When set, records each run for debugging and {@link import('../observability/replay.js').RunRecorder.replay}.
   */
  runRecorder?: import('../observability/replay.js').RunRecorder;
  /**
   * When set, the agent's final text response must parse and validate against this Zod schema.
   * Requires the optional `zod` peer dependency.
   */
  /** Requires optional peer `zod`. */
  outputSchema?: import('zod').ZodTypeAny;
  /**
   * Number of LLM re-prompts after a failed structured-output validation.
   * Total validation attempts = 1 + this value.
   * @defaultValue 3
   */
  structuredOutputRetries?: number;
}

/** Per-run options for {@link import('../agent/agent.js').Agent.run}. */
export interface AgentRunOptions<TSchema extends import('zod').ZodTypeAny = import('zod').ZodTypeAny> {
  /** Overrides {@link AgentConfig.outputSchema} for this run. */
  outputSchema?: TSchema;
}

/**
 * Final outcome of an agent run.
 *
 * @typeParam TMetadata - Arbitrary run-level metadata (latency, cost, trace IDs).
 */
export interface AgentRunMetadata extends Record<string, unknown> {
  /** Why the run ended. */
  stopReason: AgentStopReason;
  /** Optional human-readable warning (e.g. max steps reached). */
  warning?: string;
  /** Resolved model identifier from the last completion. */
  model?: string;
  /** Execution plan when a {@link AgentConfig.planner} was used. */
  plan?: import('../agent/planner.js').Plan;
  /** Structural validation of {@link plan}. */
  planValidation?: import('../agent/planner.js').PlanValidationResult;
  /** Final result quality assessment when a {@link AgentConfig.reflector} was used. */
  resultEvaluation?: import('../agent/reflector.js').ResultEvaluation;
}

export interface AgentResult<
  TMetadata extends Record<string, unknown> = AgentRunMetadata,
  TOutput = unknown,
> {
  /** Consolidated natural-language response for the user. */
  response: string;
  /**
   * Parsed object when {@link AgentConfig.outputSchema} or run `outputSchema` was set
   * and validation succeeded.
   */
  parsedOutput?: TOutput;
  /** Ordered trace of steps taken during the run. */
  steps: AgentStep[];
  /** Aggregate token usage across all provider calls. */
  totalTokens: TokenUsage;
  /** All self-evaluation runs from this agent run (when evaluation is enabled). */
  evaluations?: import('../agent/evaluation/types.js').EvaluationRecord[];
  /** How many refinements were triggered during this run. */
  refinementsUsed?: number;
  /**
   * Per-capability token usage breakdown for this agent run.
   * Present on every run when the agent is called normally.
   *
   * @example
   * const result = await agent.run('Search and summarize...');
   * console.log(formatTokenBreakdown(result.tokenBreakdown!));
   * // Token usage for run run_abc123:
   * //   Total: 3,421 tokens (2,800 in, 621 out) — $0.0124
   * //   By capability:
   * //     tool:web_search    1,823 tokens × 3 calls ($0.0072)
   * //     _llm               1,200 tokens ($0.0043)
   * //     _evaluation          398 tokens ($0.0009)
   */
  tokenBreakdown?: import('../observability/token-accounting/types.js').TokenBreakdown;
  /** Run metadata (stop reason, warnings, model). */
  metadata: TMetadata;
}


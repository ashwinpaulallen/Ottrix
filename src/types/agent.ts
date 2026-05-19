import type { TokenUsage } from './provider.js';
import type { CompletionProvider } from './provider.js';
import type { ToolExecutor } from './tools.js';
import type { MemoryProvider } from './memory.js';
import type { GuardrailConfig } from './guardrails.js';

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
  /** Tool executors available to the agent loop. */
  tools?: ToolExecutor<Record<string, unknown>, TToolOutput>[];
  /** Default system instructions for the agent. */
  systemPrompt?: string;
  /** Optional memory backend for retrieval-augmented turns. */
  memory?: MemoryProvider;
  /** Safety, budget, and validation policies. */
  guardrails?: GuardrailConfig;
  /** Maximum ReAct / tool-loop iterations before forced stop. */
  maxSteps?: number;
  /** Cumulative token budget across the entire run. */
  maxTokenBudget?: number;
  /** Callback invoked after each recorded {@link AgentStep}. */
  onStep?: (step: AgentStep) => void;
}

/**
 * Final outcome of an agent run.
 *
 * @typeParam TMetadata - Arbitrary run-level metadata (latency, cost, trace IDs).
 */
export interface AgentResult<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  /** Consolidated natural-language response for the user. */
  response: string;
  /** Ordered trace of steps taken during the run. */
  steps: AgentStep[];
  /** Aggregate token usage across all provider calls. */
  totalTokens: TokenUsage;
  /** Application-defined run metadata. */
  metadata: TMetadata;
}

import type { AgentStep } from '../types/agent.js';
import type { ChatMessage } from '../types/messages.js';
import type { CompletionParams, CompletionResult } from '../types/provider.js';

/** How a guardrail responds to a call. */
export type GuardrailAction = 'allow' | 'block' | 'modify' | 'flag';

/** Machine-readable code when a guardrail blocks execution. */
export type GuardrailBlockCode = 'max_steps' | 'token_budget' | 'cost_budget' | 'guardrail';

/** Outcome returned by an individual guardrail handler. */
export interface GuardrailDecision {
  /** What to do with the call. */
  action: GuardrailAction;
  /** Machine-readable block reason when `action` is `block`. */
  code?: GuardrailBlockCode;
  /** Human-readable explanation (especially for `block`). */
  reason?: string;
  /** Advisory tags accumulated across the chain. */
  flags?: string[];
  /** Replacement completion params when `action` is `modify` (LLM pre). */
  params?: CompletionParams;
  /** Replacement conversation when `action` is `modify` (LLM pre). */
  messages?: ChatMessage[];
  /** Replacement model text when `action` is `modify` (LLM post). */
  modifiedText?: string;
  /** Replacement tool input when `action` is `modify` (tool pre). */
  toolInput?: Record<string, unknown>;
  /** Replacement tool result message when `action` is `modify` (tool post). */
  toolResultMessage?: string;
}

/** Context passed to LLM guardrail hooks. */
export interface LlmGuardrailContext {
  phase: 'llm';
  timing: 'pre' | 'post';
  agentName: string;
  messages: ChatMessage[];
  params: CompletionParams;
  result?: CompletionResult;
  durationMs?: number;
}

/** Context passed to tool guardrail hooks. */
export interface ToolGuardrailContext {
  phase: 'tool';
  timing: 'pre' | 'post';
  agentName: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  durationMs?: number;
  /** Populated on pre-tool for approval flows. */
  pendingStep?: AgentStep;
  /** Set by post-tool handlers to override the tool result message. */
  toolResultMessage?: string;
}

/** Result after running the middleware pipeline. */
export interface GuardrailPipelineResult<T extends LlmGuardrailContext | ToolGuardrailContext> {
  proceed: boolean;
  reason?: string;
  /** Set when the pipeline blocks (maps to agent stop reasons). */
  code?: GuardrailBlockCode;
  flags: string[];
  context: T;
}

/** Pluggable guardrail participating in {@link import('./middleware.js').GuardrailMiddleware}. */
export interface GuardrailHandler {
  /** Unique name for logging and audit trails. */
  name: string;
  beforeLlm?(context: LlmGuardrailContext): Promise<GuardrailDecision | void>;
  afterLlm?(context: LlmGuardrailContext): Promise<GuardrailDecision | void>;
  beforeTool?(context: ToolGuardrailContext): Promise<GuardrailDecision | void>;
  afterTool?(context: ToolGuardrailContext): Promise<GuardrailDecision | void>;
}

/** Guardrail handler that can reset per-run state. */
export interface StatefulGuardrailHandler extends GuardrailHandler {
  reset(): void;
}

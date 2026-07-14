import { z } from 'zod';

// ── Sufficiency evaluation result ──────────────────────────────────────────

export const SufficiencyResultSchema = z.object({
  sufficient: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  missingAspects: z.array(z.string()).optional(),
  suggestedAction: z
    .enum([
      'finalize', // response is complete — stop
      'use_tool', // a specific tool would help
      'clarify', // ask the user a question
      'rethink', // current approach is wrong, start fresh angle
      'refine_response', // has all info, just needs better wording
    ])
    .optional(),
  suggestedTool: z.string().optional(), // set when suggestedAction === 'use_tool'
});

export type SufficiencyResult = z.infer<typeof SufficiencyResultSchema>;

// ── Per-step evaluation record (appended to AgentStep) ────────────────────

export const EvaluationRecordSchema = z.object({
  iteration: z.number(),
  evaluatedAt: z.number(),
  result: SufficiencyResultSchema,
  tokenUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    })
    .optional(),
  durationMs: z.number(),
});

export type EvaluationRecord = z.infer<typeof EvaluationRecordSchema>;

// ── Config ─────────────────────────────────────────────────────────────────

export const EvaluationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  threshold: z.number().min(0).max(1).default(0.8),
  maxRefinements: z.number().int().min(0).max(5).default(2),
  model: z.string().optional(), // use a cheaper model for eval (e.g. 'claude-haiku-3.5')
  maxEvalTokens: z.number().default(512), // token budget for evaluation call
  skipIfNoTools: z.boolean().default(false), // skip eval if agent has no tools (simple Q&A)
  // Criteria help the evaluator understand what "sufficient" means for this agent:
  criteria: z.array(z.string()).optional(),
  // e.g. ['Answers all parts of the question', 'Includes specific examples when asked',
  //        'Response is in the same language as the question']
});

export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

// ── Evaluator strategy interface ───────────────────────────────────────────

/** Optional metadata from the last evaluate() call (for telemetry). */
export interface EvaluationObservation {
  /** True when an LLM completion was used for evaluation. */
  usedLlm: boolean;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Model id used for the evaluation call, when known. */
  model?: string;
}

export interface EvaluatorStrategy {
  evaluate(context: EvaluationContext): Promise<SufficiencyResult>;
  /** Observability metadata from the most recent {@link evaluate} call. */
  getLastObservation?(): EvaluationObservation | undefined;
}

export interface EvaluationContext {
  originalGoal: string; // the user's original request
  currentResponse: string; // the response being evaluated
  conversationHistory: Array<{ role: string; content: string }>;
  refinementNumber: number; // which refinement iteration we're on (0 = first eval)
  stepsSoFar: number; // how many ReAct steps have run
  toolsAvailable: string[]; // names of tools the agent has
  toolsUsed: string[]; // tools already called in this run
  criteria?: string[]; // evaluation criteria from EvaluationConfig
}

// ── Events emitted during evaluation (for streaming callers) ──────────────

export type EvaluationEvent =
  | { type: 'evaluation_start'; refinement: number }
  | { type: 'evaluation_result'; result: SufficiencyResult; durationMs: number }
  | { type: 'refinement_start'; missingAspects: string[]; suggestedAction: string }
  | { type: 'evaluation_skipped'; reason: string }
  | { type: 'max_refinements_reached'; refinements: number };

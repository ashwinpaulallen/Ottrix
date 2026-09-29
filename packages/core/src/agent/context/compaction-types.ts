import { z } from 'zod';
import type { CompletionProvider } from '../../types/provider.js';

// ── Compaction strategy ────────────────────────────────────────────────────

export const CompactionStrategySchema = z.enum([
  'hierarchical', // topic index + prose digest (new, recommended)
  'prose', // single prose summary (current behavior)
  'truncate', // sliding window, no LLM call (safe fallback)
]);
export type CompactionStrategy = z.infer<typeof CompactionStrategySchema>;

// ── Failure policy when summarization LLM call errors ─────────────────────

export const CompactionFailurePolicySchema = z.enum([
  'truncate', // slide the window, discard oldest messages (safe)
  'throw', // propagate the error to the caller (strict)
  'preserve', // keep full history, risk hitting context limit (risky)
]);
export type CompactionFailurePolicy = z.infer<typeof CompactionFailurePolicySchema>;

// ── Compaction config (added to AgentConfig) ──────────────────────────────

export const CompactionConfigSchema = z.object({
  strategy: CompactionStrategySchema.default('prose'),

  // How many recent messages to ALWAYS keep verbatim (never summarized)
  // These are the high-attention anchor at the end of context
  recentMessagesToPreserve: z.number().int().min(2).max(20).default(4),

  // Maximum tokens the summary/digest may occupy
  maxSummaryTokens: z.number().int().min(100).max(4000).default(800),

  // Dedicated provider for compaction LLM calls.
  // Falls back to the agent's primary provider if not set.
  // Set to a cheap/fast model for cost savings.
  provider: z.custom<CompletionProvider>().optional(),

  // Model override for the compaction provider (e.g. 'claude-haiku-3.5')
  model: z.string().optional(),

  // Maximum number of cached digests to keep in memory
  // Prevents unbounded memory growth
  digestCacheCapacity: z.number().int().min(1).max(200).default(50),

  // What to do when summarization fails
  failurePolicy: CompactionFailurePolicySchema.default('truncate'),

  // Soft threshold: start Phase 1 offloading (see Tier 2 token optimization)
  softThreshold: z.number().min(0.5).max(0.9).default(0.60),

  // Medium threshold: replace old tool results with outcome summaries
  mediumThreshold: z.number().min(0.6).max(0.95).default(0.75),

  // Hard threshold: run full LLM compaction
  hardThreshold: z.number().min(0.7).max(0.99).default(0.85),
}).refine(
  (data) => data.softThreshold < data.mediumThreshold && data.mediumThreshold < data.hardThreshold,
  { message: 'softThreshold < mediumThreshold < hardThreshold must hold' },
);
/** Options accepted on agent config. Defaults apply when {@link CompactionConfigSchema} is parsed. */
export type CompactionConfig = z.input<typeof CompactionConfigSchema>;

/** Compaction config after Zod defaults and threshold checks. */
export type ResolvedCompactionConfig = z.output<typeof CompactionConfigSchema>;

// ── Compaction output ──────────────────────────────────────────────────────

export interface CompactionOutput {
  strategy: CompactionStrategy;
  // Hierarchical strategy populates both:
  topicIndex?: string; // concise bullet list of topics/key facts covered
  digest?: string; // prose summary of the folded segment
  // Prose strategy populates only digest
  // Truncate strategy populates neither
  foldedMessageCount: number; // how many messages were compacted
  inputTokenEstimate: number;
  outputTokenEstimate: number;
  cacheHit: boolean; // was this digest already cached?
  contentHash?: string; // hash used for cache lookup
}

// ── Telemetry event for compaction outcomes ────────────────────────────────

export interface CompactionTelemetryEvent {
  trigger: 'soft' | 'medium' | 'hard';
  strategy: CompactionStrategy;
  phase: 'offload' | 'outcome_summary' | 'llm_summary';
  foldedMessageCount: number;
  inputTokenEstimate: number;
  outputTokenEstimate: number;
  cacheHit: boolean;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  durationMs: number;
  // Never include message content — only metadata
}

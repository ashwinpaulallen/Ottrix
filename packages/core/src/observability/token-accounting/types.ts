import { z } from 'zod';

// ── Per-capability usage ───────────────────────────────────────────────────

export const CapabilityUsageSchema = z.object({
  capability: z.string(), // e.g. 'tool:web_search', 'llm', 'evaluation', '_unscoped'
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int().default(0), // Anthropic prompt cache reads
  cacheWriteTokens: z.number().int().default(0), // Anthropic prompt cache writes
  calls: z.number().int(),
  costUsd: z.number().optional(), // if Pricing module is available
});

export type CapabilityUsage = z.infer<typeof CapabilityUsageSchema>;

// ── Full breakdown for a run ───────────────────────────────────────────────

export const TokenBreakdownSchema = z.object({
  runId: z.string(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCacheReadTokens: z.number().int().default(0),
  totalCacheWriteTokens: z.number().int().default(0),
  totalTokens: z.number().int(),
  totalCalls: z.number().int(),
  totalCostUsd: z.number().optional(),
  byCapability: z.record(z.string(), CapabilityUsageSchema),
  // Summary helpers
  topCapabilityByTokens: z.string().optional(), // which capability used most tokens
  topCapabilityByCost: z.string().optional(), // which capability cost most
});

export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;

// ── What gets recorded on each LLM call ───────────────────────────────────

export interface TokenRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  provider?: string;
}

// ── Capability name conventions ────────────────────────────────────────────
// Use these constants everywhere for consistency:

export const CAPABILITY = {
  LLM: '_llm', // main agent LLM call
  EVALUATION: '_evaluation', // self-evaluation call (Roadmap item 1)
  SUMMARIZATION: '_summarization', // context compaction summary call
  TOOL_PREFIX: 'tool:', // + tool name e.g. 'tool:web_search'
  UNSCOPED: '_unscoped', // fallback when no scope is active
} as const;

export type BuiltinCapability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

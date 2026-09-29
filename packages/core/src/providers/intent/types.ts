import { z } from 'zod';

import type { CompletionProvider } from '../../types/provider.js';

// ── Completion intent ──────────────────────────────────────────────────────

/**
 * Describes the caller's requirements for a completion, independent of
 * which provider or model fulfills it.
 *
 * Intent is resolved by the ModelCatalog to a specific provider and model.
 * The resolution reason is included in telemetry.
 */
export const CompletionIntentSchema = z.object({
  // Semantic role for this completion
  role: z.enum([
    'reasoning',       // complex multi-step thinking, tool use
    'summarization',   // compaction, digest generation
    'evaluation',      // self-evaluation, quality scoring
    'planning',        // plan creation and validation
    'extraction',      // structured data extraction from text
    'embedding',       // embedding (separate from completion, but catalogable)
    'general',         // default — no specific optimization
  ]).default('general'),

  // Performance preference
  prefer: z.enum([
    'quality',         // best output quality regardless of cost
    'speed',           // lowest latency
    'economy',         // lowest token cost
    'balanced',        // quality/cost balance (default)
  ]).default('balanced'),

  // Capability requirements
  requires: z.object({
    tools: z.boolean().optional(),         // must support function calling
    vision: z.boolean().optional(),        // must accept image inputs
    streaming: z.boolean().optional(),     // must support streaming
    minContextTokens: z.number().optional(), // minimum context window size
  }).optional(),
}).strict();

export type CompletionIntent = z.infer<typeof CompletionIntentSchema>;

// ── Model descriptor ───────────────────────────────────────────────────────

export const ModelDescriptorSchema = z.object({
  key: z.string(),           // catalog key e.g. 'claude-sonnet', 'cheap-chat'
  provider: z.string(),      // registered provider name in ProviderRegistry
  model: z.string(),         // provider-native model ID
  displayName: z.string(),

  // Capabilities (used to filter by intent.requires)
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  supportsStreaming: z.boolean().default(true),
  contextTokens: z.number().optional(),

  // Cost and performance profile (used to match intent.prefer)
  costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
  speedTier: z.enum(['fast', 'medium', 'slow']).optional(),
  qualityTier: z.enum(['frontier', 'capable', 'basic']).optional(),

  // Which intents this model is preferred for
  preferredFor: z.array(z.string()).optional(),  // e.g. ['summarization', 'evaluation']
});

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

// ── Resolution result ──────────────────────────────────────────────────────

export interface IntentResolutionResult {
  descriptor: ModelDescriptor;
  provider: CompletionProvider;
  model: string;
  reason: string;            // human-readable explanation for telemetry
}

// ── Catalog config ─────────────────────────────────────────────────────────

export interface ModelCatalogConfig {
  models: ModelDescriptor[];
  // Map from intent role+prefer combination to preferred catalog key
  // e.g. { 'summarization:economy': 'haiku', 'reasoning:quality': 'claude-opus' }
  intentMap?: Record<string, string>;
}

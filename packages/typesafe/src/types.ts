import type { EvaluationContext, SufficiencyResult } from 'ottrix';

// ── Jev confidence wrapper ────────────────────────────────────────────────

/**
 * A Jev decision paired with its calibrated confidence.
 * Higher confidence means higher accuracy — use it to decide whether to
 * act automatically or escalate to an LLM/human.
 */
export interface JevDecision<T> {
  value: T;
  confidence: number; // 0.0 – 1.0, calibrated: 0.9 means ~90% accurate
  latencyMs: number;
}

// ── Sufficiency evaluation ─────────────────────────────────────────────────

export interface JevSufficiencyDecision {
  sufficient: JevDecision<boolean>;
  missingAspects: JevDecision<string[]>;
  suggestedAction: JevDecision<'finalize' | 'use_tool' | 'clarify' | 'rethink' | 'refine_response'>;
}

// ── Injection classification ───────────────────────────────────────────────

export type InjectionCategory =
  | 'clean'
  | 'instruction_override'
  | 'jailbreak'
  | 'data_exfiltration'
  | 'role_play_attack'
  | 'encoding_trick';

export interface JevInjectionDecision {
  isInjection: JevDecision<boolean>;
  category: JevDecision<InjectionCategory>;
  severity: JevDecision<'none' | 'low' | 'medium' | 'high' | 'critical'>;
}

// ── Agent routing ──────────────────────────────────────────────────────────

export interface JevRoutingDecision<TAgentName extends string> {
  agentName: JevDecision<TAgentName>;
  confidence: number;
}

// ── Tool acceptance ────────────────────────────────────────────────────────

export interface JevToolAcceptanceDecision {
  isRelated: JevDecision<boolean>;
  canExecuteNow: JevDecision<boolean>;
  suggestedAlternative: JevDecision<string | null>;
}

// ── Generic decision ───────────────────────────────────────────────────────

export interface JevBooleanDecision {
  value: JevDecision<boolean>;
}

export interface JevChoiceDecision<T extends string> {
  value: JevDecision<T>;
}

export interface JevScoreDecision {
  value: JevDecision<number>;
}

// ── Client config ──────────────────────────────────────────────────────────

export interface TypeSafeClientConfig {
  apiKey?: string; // default: TYPESAFE_API_KEY env var
  timeoutMs?: number; // default: 5000
  maxRetries?: number; // default: 1 (Jev is fast, no need for many retries)
}

// ── Confidence thresholds ──────────────────────────────────────────────────

/**
 * When Jev's confidence is below these thresholds, fall back to LLM or
 * human review instead of acting on the decision autonomously.
 */
export interface ConfidenceThresholds {
  autoAct: number; // default 0.85 — act without LLM if confidence >= this
  escalate: number; // default 0.50 — below this, always escalate to LLM
}

export const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  autoAct: 0.85,
  escalate: 0.5,
};

export type { JevEvaluatorConfig } from './evaluator.js';
export type { JevGuardrailConfig } from './guardrail.js';
export type { RouterConfig } from './router.js';
export type { JevDecisionMakerConfig } from './decisions.js';

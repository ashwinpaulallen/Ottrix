import type { AgentResult } from '../types/agent.js';

/** A single test case in an evaluation dataset. */
export interface EvalDatasetEntry {
  /** Prompt or task passed to the agent. */
  input: string;
  /** Optional reference answer for comparison scorers. */
  expectedOutput?: string;
  /** Extra context forwarded to scorers (e.g. latency, token usage). */
  metadata?: Record<string, unknown>;
  /** Tags for filtering or grouping results. */
  tags?: string[];
}

/** Normalized score from a single scorer for one eval entry. */
export interface ScoreResult {
  /** Normalized score in the range 0–1. */
  score: number;
  /** Human-readable explanation (especially for model-graded scorers). */
  reason?: string;
  /** Scorer-specific details (raw metrics, parsed JSON, etc.). */
  metadata?: Record<string, unknown>;
}

/** Outcome of evaluating one dataset entry. */
export interface EvalResult {
  entry: EvalDatasetEntry;
  agentOutput: AgentResult;
  /** Scorer name → score. */
  scores: Record<string, ScoreResult>;
  /** Wall-clock duration of the agent run in milliseconds. */
  duration: number;
  /** Set when the agent run threw before producing a result. */
  error?: string;
}

/** Aggregated statistics for a scorer across all eval results. */
export interface AggregateScore {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  count: number;
  /** Ten buckets covering [0–0.1), [0.1–0.2), …, [0.9–1.0]. */
  histogram: number[];
}

/** Configuration snapshot stored on an {@link EvalReport}. */
export interface EvalRunConfig {
  name: string;
  agentName: string;
  concurrency: number;
  scorerNames: string[];
  datasetSize: number;
}

/** Full outcome of an evaluation run. */
export interface EvalReport {
  name: string;
  timestamp: number;
  results: EvalResult[];
  /** Scorer name → aggregated statistics. */
  aggregates: Record<string, AggregateScore>;
  duration: number;
  config: EvalRunConfig;
}

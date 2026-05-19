import type { Agent } from '../agent/agent.js';
import type { AgentResult } from '../types/agent.js';
import { runWithConcurrency } from '../orchestration/runner.js';
import { clampScore, type Scorer } from './scorers.js';
import type {
  AggregateScore,
  EvalDatasetEntry,
  EvalReport,
  EvalResult,
  EvalRunConfig,
  ScoreResult,
} from './types.js';

/** Options for {@link EvalRunner}. */
export interface EvalRunnerOptions {
  agent: Agent;
  dataset: EvalDatasetEntry[];
  scorers: Scorer[];
  /** Report name. Defaults to the agent name. */
  name?: string;
  /** Parallel eval runs. @defaultValue 3 */
  concurrency?: number;
  /** Provider label used by cost scorers. @defaultValue 'default' */
  provider?: string;
  onProgress?: (completed: number, total: number) => void;
}

/** Runs an agent against a dataset and scores the outputs. */
export class EvalRunner {
  private readonly agent: Agent;
  private readonly dataset: EvalDatasetEntry[];
  private readonly scorers: Scorer[];
  private readonly name: string;
  private readonly concurrency: number;
  private readonly provider: string;
  private readonly onProgress?: (completed: number, total: number) => void;

  constructor(options: EvalRunnerOptions) {
    if (options.scorers.length === 0) {
      throw new Error('At least one scorer is required');
    }

    const scorerNames = options.scorers.map((scorer) => scorer.name);
    if (new Set(scorerNames).size !== scorerNames.length) {
      throw new Error(`Duplicate scorer names: ${scorerNames.join(', ')}`);
    }

    const concurrency = options.concurrency ?? 3;
    if (concurrency < 1) {
      throw new Error('concurrency must be >= 1');
    }

    this.agent = options.agent;
    this.dataset = options.dataset;
    this.scorers = options.scorers;
    this.name = options.name ?? options.agent.getName();
    this.concurrency = concurrency;
    this.provider = options.provider ?? 'default';
    this.onProgress = options.onProgress;
  }

  /** Evaluate every dataset entry and return a full report. */
  async run(): Promise<EvalReport> {
    const started = Date.now();
    let completed = 0;

    const tasks = this.dataset.map(
      (entry) => () =>
        this.evaluateEntry(entry).then((result) => {
          completed += 1;
          this.onProgress?.(completed, this.dataset.length);
          return result;
        }),
    );

    const results = await runWithConcurrency(tasks, this.concurrency);
    const aggregates = computeAggregates(results, this.scorers);

    const config: EvalRunConfig = {
      name: this.name,
      agentName: this.agent.getName(),
      concurrency: this.concurrency,
      scorerNames: this.scorers.map((scorer) => scorer.name),
      datasetSize: this.dataset.length,
    };

    return {
      name: this.name,
      timestamp: Date.now(),
      results,
      aggregates,
      duration: Date.now() - started,
      config,
    };
  }

  /** Run the same dataset against multiple agents for side-by-side comparison. */
  async runComparison(agents: Agent[]): Promise<EvalReport[]> {
    return Promise.all(
      agents.map((agent) =>
        new EvalRunner({
          agent,
          dataset: this.dataset,
          scorers: this.scorers,
          name: agent.getName(),
          concurrency: this.concurrency,
          provider: this.provider,
        }).run(),
      ),
    );
  }

  private async evaluateEntry(entry: EvalDatasetEntry): Promise<EvalResult> {
    const started = Date.now();
    let agentOutput: AgentResult;
    let error: string | undefined;

    try {
      agentOutput = await this.agent.run(entry.input);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      agentOutput = errorAgentResult(error);
    }

    const duration = Date.now() - started;
    const scoringMetadata = {
      ...entry.metadata,
      durationMs: duration,
      tokenUsage: agentOutput.totalTokens,
      provider: this.provider,
      ...(error ? { agentError: error } : {}),
    };

    const scores: Record<string, ScoreResult> = {};
    for (const scorer of this.scorers) {
      scores[scorer.name] = error
        ? { score: 0, reason: `Agent error: ${error}` }
        : await safeScore(scorer, entry, agentOutput.response, scoringMetadata);
    }

    return {
      entry,
      agentOutput,
      scores,
      duration,
      error,
    };
  }
}

/** Convenience wrapper around {@link EvalRunner.run}. */
export async function evaluate(options: EvalRunnerOptions): Promise<EvalReport> {
  return new EvalRunner(options).run();
}

function errorAgentResult(message: string): AgentResult {
  return {
    response: '',
    steps: [],
    totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    metadata: { stopReason: 'error', warning: message },
  };
}

async function safeScore(
  scorer: Scorer,
  entry: EvalDatasetEntry,
  output: string,
  metadata: Record<string, unknown>,
): Promise<ScoreResult> {
  try {
    const result = await scorer.score(entry.input, output, entry.expectedOutput, metadata);
    return {
      ...result,
      score: clampScore(result.score),
    };
  } catch (error) {
    return {
      score: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Compute aggregate statistics for each scorer across eval results. */
export function computeAggregates(
  results: EvalResult[],
  scorers: Scorer[],
): Record<string, AggregateScore> {
  const aggregates: Record<string, AggregateScore> = {};

  for (const scorer of scorers) {
    const values = results.map((result) => clampScore(result.scores[scorer.name]?.score ?? 0));
    aggregates[scorer.name] = aggregateScores(values);
  }

  return aggregates;
}

/** Aggregate a list of normalized scores into summary statistics. */
export function aggregateScores(scores: number[]): AggregateScore {
  const normalized = scores.map(clampScore);
  const count = normalized.length;
  const histogram = new Array<number>(10).fill(0);

  if (count === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0, count: 0, histogram };
  }

  const sorted = [...normalized].sort((a, b) => a - b);
  const mean = normalized.reduce((sum, value) => sum + value, 0) / count;
  const median =
    count % 2 === 0
      ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
      : sorted[Math.floor(count / 2)];
  const min = sorted[0];
  const max = sorted[count - 1];
  const variance = normalized.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const stdDev = Math.sqrt(variance);

  for (const value of normalized) {
    const bucket = Math.min(9, Math.floor(value * 10));
    histogram[bucket] += 1;
  }

  return { mean, median, min, max, stdDev, count, histogram };
}

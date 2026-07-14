import type { CompletionProvider } from '../../types/provider.js';
import { HeuristicEvaluator } from './heuristic-evaluator.js';
import { LLMEvaluator } from './llm-evaluator.js';
import type {
  EvaluationConfig,
  EvaluationContext,
  EvaluationObservation,
  EvaluatorStrategy,
  SufficiencyResult,
} from './types.js';

export class CompositeEvaluator implements EvaluatorStrategy {
  private heuristic: HeuristicEvaluator;
  private llm: LLMEvaluator;
  private lastObservation: EvaluationObservation = { usedLlm: false };

  constructor(
    provider: CompletionProvider,
    private config: EvaluationConfig,
  ) {
    this.heuristic = new HeuristicEvaluator();
    this.llm = new LLMEvaluator(provider, config);
  }

  getLastObservation(): EvaluationObservation | undefined {
    return this.lastObservation;
  }

  async evaluate(ctx: EvaluationContext): Promise<SufficiencyResult> {
    this.lastObservation = { usedLlm: false };

    // 1. Run heuristics first — they're free
    const heuristicResult = await this.heuristic.evaluate(ctx);

    // 2. If heuristics clearly found something wrong, no need for LLM eval
    if (!heuristicResult.sufficient && heuristicResult.confidence >= 0.75) {
      return heuristicResult;
    }

    // 3. Heuristics passed OR were not confident enough — run LLM eval
    const llmResult = await this.llm.evaluate(ctx);
    this.lastObservation = this.llm.getLastObservation() ?? { usedLlm: true };

    // 4. Merge: if either finds insufficient, report as insufficient
    //    Use the more specific/detailed result
    if (!llmResult.sufficient || !heuristicResult.sufficient) {
      const base = !llmResult.sufficient ? llmResult : heuristicResult;
      return {
        ...base,
        sufficient: false,
        // Combine missing aspects from both
        missingAspects: [
          ...(llmResult.missingAspects ?? []),
          ...(heuristicResult.missingAspects ?? []),
        ].filter((v, i, a) => a.indexOf(v) === i), // deduplicate
      };
    }

    return llmResult;
  }
}

/** Factory — the public API for creating evaluators. */
export function createEvaluator(
  provider: CompletionProvider,
  config: EvaluationConfig,
): EvaluatorStrategy {
  return new CompositeEvaluator(provider, config);
}

import { JevClient } from './client.js';
import {
  DEFAULT_THRESHOLDS,
  type ConfidenceThresholds,
  type JevDecision,
  type TypeSafeClientConfig,
} from './types.js';

export interface JevDecisionMakerConfig extends TypeSafeClientConfig {
  thresholds?: Partial<ConfidenceThresholds>;
}

export class JevDecisionMaker {
  private client: JevClient;
  private thresholds: ConfidenceThresholds;

  constructor(config?: JevDecisionMakerConfig) {
    this.client = new JevClient(config);
    this.thresholds = {
      autoAct: config?.thresholds?.autoAct ?? DEFAULT_THRESHOLDS.autoAct,
      escalate: config?.thresholds?.escalate ?? DEFAULT_THRESHOLDS.escalate,
    };
  }

  // ── Fraud scoring ──────────────────────────────────────────────────────

  /**
   * Score an e-commerce order for fraud risk.
   * Returns a score 0-10 and a recommendation.
   * Use this as a pre-filter before running the full fraud agent.
   */
  async scoreFraud(orderDetails: {
    orderValue: number;
    customerAge?: number; // days since account created
    cardVelocity?: number; // times this card used in last hour
    addressMatch?: boolean; // shipping matches billing
    isFirstOrder?: boolean;
    [key: string]: unknown;
  }): Promise<{
    score: JevDecision<number>; // 0-10, 10 = definitely fraud
    recommendation: JevDecision<'approve' | 'review' | 'reject'>;
    shouldRunFullAgent: boolean; // true when in the grey zone
  }> {
    const { answers, latencyMs } = await this.client.decide({
      state: orderDetails,
      questions: {
        fraudScore: JevClient.score('Rate fraud risk from 0 (safe) to 10 (definitely fraud)', 10),
        recommendation: JevClient.choice('What action should be taken?', {
          approve: null,
          review: null,
          reject: null,
        }),
      },
    });

    const score = answers.fraudScore.score ?? 5;
    const scoreConfidence = answers.fraudScore.confidence;

    return {
      score: { value: score, confidence: scoreConfidence, latencyMs },
      recommendation: {
        value: (answers.recommendation.choice ?? 'review') as 'approve' | 'review' | 'reject',
        confidence: answers.recommendation.confidence,
        latencyMs,
      },
      // Grey-zone scores, or any score Jev is not confident about, still need the full agent.
      shouldRunFullAgent: (score >= 3 && score <= 7) || scoreConfidence < this.thresholds.autoAct,
    };
  }

  // ── Tool acceptance ────────────────────────────────────────────────────

  /**
   * Replaces LLM-based tool.isRelated() — decides if a tool is relevant
   * to the current request and can execute now.
   */
  async checkToolAcceptance(params: {
    toolName: string;
    toolDescription: string;
    userRequest: string;
    isAuthenticated?: boolean;
    rateLimitRemaining?: number;
    availableAlternatives?: string[];
  }): Promise<{
    isRelated: JevDecision<boolean>;
    canExecuteNow: JevDecision<boolean>;
    suggestedAlternative: JevDecision<string | null>;
  }> {
    const { answers, latencyMs } = await this.client.decide({
      state: {
        toolName: params.toolName,
        toolDescription: params.toolDescription,
        userRequest: params.userRequest,
        isAuthenticated: params.isAuthenticated ?? true,
        rateLimitRemaining: params.rateLimitRemaining ?? 100,
        alternatives: params.availableAlternatives?.join(', ') ?? 'none',
      },
      questions: {
        isRelated: JevClient.boolean('Is this tool relevant to handling the user request?'),
        canExecuteNow: JevClient.boolean(
          'Can this tool execute successfully right now given current conditions (auth, rate limits)?',
        ),
        suggestedAlternative: JevClient.choice(
          'If not executable now, which alternative tool should be used instead?',
          Object.fromEntries([
            ['none', null],
            ...(params.availableAlternatives ?? []).map((tool) => [tool, null]),
          ]) as Record<string, null>,
        ),
      },
    });

    const alt = answers.suggestedAlternative.choice;

    return {
      isRelated: {
        value: answers.isRelated.boolean ?? false,
        confidence: answers.isRelated.confidence,
        latencyMs,
      },
      canExecuteNow: {
        value: answers.canExecuteNow.boolean ?? true,
        confidence: answers.canExecuteNow.confidence,
        latencyMs,
      },
      suggestedAlternative: {
        value: alt === 'none' ? null : (alt ?? null),
        confidence: answers.suggestedAlternative.confidence,
        latencyMs,
      },
    };
  }

  // ── Generic classify / score / boolean ────────────────────────────────

  /**
   * Generic boolean decision. The fundamental building block.
   */
  async decide(params: {
    state: Record<string, unknown>;
    question: string;
  }): Promise<JevDecision<boolean>> {
    const { answers, latencyMs } = await this.client.decide({
      state: params.state,
      questions: {
        answer: JevClient.boolean(params.question),
      },
    });

    return {
      value: answers.answer.boolean ?? false,
      confidence: answers.answer.confidence,
      latencyMs,
    };
  }

  /**
   * Generic classification decision.
   */
  async classify<T extends string>(params: {
    state: Record<string, unknown>;
    question: string;
    options: T[];
  }): Promise<JevDecision<T>> {
    const { answers, latencyMs } = await this.client.decide({
      state: params.state,
      questions: {
        choice: JevClient.choice(
          params.question,
          Object.fromEntries(params.options.map((option) => [option, null])) as Record<T, null>,
        ),
      },
    });

    return {
      value: (answers.choice.choice ?? params.options[0]) as T,
      confidence: answers.choice.confidence,
      latencyMs,
    };
  }

  /**
   * Generic score decision.
   */
  async scoreOn(params: {
    state: Record<string, unknown>;
    question: string;
    maxScore: number;
  }): Promise<JevDecision<number>> {
    const { answers, latencyMs } = await this.client.decide({
      state: params.state,
      questions: {
        score: JevClient.score(params.question, params.maxScore),
      },
    });

    return {
      value: answers.score.score ?? 0,
      confidence: answers.score.confidence,
      latencyMs,
    };
  }
}

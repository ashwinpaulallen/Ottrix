import type { EvaluationContext, EvaluatorStrategy, SufficiencyResult } from 'ottrix';
import { JevClient } from './client.js';
import {
  DEFAULT_THRESHOLDS,
  type ConfidenceThresholds,
  type TypeSafeClientConfig,
} from './types.js';

export interface JevEvaluatorConfig extends TypeSafeClientConfig {
  thresholds?: Partial<ConfidenceThresholds>;
}

export class JevEvaluatorStrategy implements EvaluatorStrategy {
  private client: JevClient;
  private thresholds: ConfidenceThresholds;

  constructor(config?: JevEvaluatorConfig) {
    this.client = new JevClient(config);
    this.thresholds = {
      autoAct: config?.thresholds?.autoAct ?? DEFAULT_THRESHOLDS.autoAct,
      escalate: config?.thresholds?.escalate ?? DEFAULT_THRESHOLDS.escalate,
    };
  }

  async evaluate(ctx: EvaluationContext): Promise<SufficiencyResult> {
    try {
      const { answers } = await this.client.decide({
        state: {
          originalGoal: ctx.originalGoal,
          currentResponse: ctx.currentResponse,
          refinementNumber: ctx.refinementNumber,
          stepCount: ctx.stepsSoFar,
          toolsAvailable: ctx.toolsAvailable.join(', '),
          toolsUsed: ctx.toolsUsed.join(', '),
          responseLength: ctx.currentResponse.length,
          ...(ctx.criteria?.length ? { criteria: ctx.criteria.join('; ') } : {}),
        },
        questions: {
          sufficient: JevClient.boolean(
            'Does the response fully and accurately address ALL aspects of the original request?',
          ),
          missingInfo: JevClient.boolean(
            'Is there missing information that the agent could retrieve using its available tools?',
          ),
          suggestedAction: JevClient.choice('What is the best next action for the agent?', {
            finalize: null, // response is complete
            use_tool: null, // call a tool to get missing info
            clarify: null, // ask user a question
            rethink: null, // current approach is wrong
            refine_response: null, // has info, needs better phrasing
          }),
          qualityScore: JevClient.score('Rate the response quality', 5),
        },
      });

      const sufficient = answers.sufficient.boolean ?? true;
      const confidence = answers.sufficient.confidence;
      const suggestedAction = (answers.suggestedAction.choice ??
        'finalize') as SufficiencyResult['suggestedAction'];

      // Low confidence → don't trust the decision, lean toward finalizing
      // to avoid an evaluation-induced infinite loop
      if (confidence < this.thresholds.escalate) {
        return {
          sufficient: true,
          confidence: 0.5,
          reason: 'Jev confidence below escalation threshold — assuming sufficient',
          suggestedAction: 'finalize',
        };
      }

      return {
        sufficient,
        confidence,
        reason: sufficient
          ? `Response addresses the request (quality: ${answers.qualityScore.score}/5)`
          : `Response incomplete — suggested action: ${suggestedAction}`,
        missingAspects:
          !sufficient && answers.missingInfo.boolean
            ? ['Agent has tools available that may help fill the gap']
            : undefined,
        suggestedAction: sufficient ? 'finalize' : suggestedAction,
      };
    } catch (err) {
      // Fail safe: if Jev is down or errors, assume sufficient
      // to avoid blocking the agent. Log the error.
      console.warn('[ottrix:jev-evaluator] Jev evaluation failed, assuming sufficient:', err);
      return {
        sufficient: true,
        confidence: 0.5,
        reason: 'Jev evaluation failed — assuming sufficient (fail-safe)',
        suggestedAction: 'finalize',
      };
    }
  }
}

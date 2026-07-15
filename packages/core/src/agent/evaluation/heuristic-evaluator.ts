import type { EvaluationContext, EvaluatorStrategy, SufficiencyResult } from './types.js';

type HeuristicFailure = {
  reason: string;
  suggestedAction?: SufficiencyResult['suggestedAction'];
};

export class HeuristicEvaluator implements EvaluatorStrategy {
  evaluate(ctx: EvaluationContext): Promise<SufficiencyResult> {
    const checks = [
      this.checkForHedgingWithoutAction(ctx),
      this.checkForExplicitIncompleteness(ctx),
      this.checkForQuestionWithoutAnswer(ctx),
      this.checkResponseLength(ctx),
      this.checkForErrorSigns(ctx),
    ];

    const failures = checks.filter((c): c is HeuristicFailure => c !== null);

    if (failures.length === 0) {
      return Promise.resolve({
        sufficient: true,
        confidence: 0.65, // heuristics can't be highly confident — use LLM for final say
        reason: 'Passed all heuristic checks',
        suggestedAction: 'finalize',
      });
    }

    // Clear heuristic failures: confidence is high enough to short-circuit the
    // LLM evaluator and to trigger refinement under the default threshold (0.8).
    const [firstFailure] = failures;
    return Promise.resolve({
      sufficient: false,
      confidence: 0.85,
      reason: firstFailure.reason,
      missingAspects: failures.map((f) => f.reason),
      suggestedAction: firstFailure.suggestedAction ?? 'refine_response',
    });
  }

  // ── Individual heuristic checks ────────────────────────────────────────
  // Each returns null if it passes, or a failure reason if it detects a problem.

  private checkForHedgingWithoutAction(ctx: EvaluationContext): HeuristicFailure | null {
    const response = ctx.currentResponse.toLowerCase();

    // Patterns like "I'll look that up" or "I need to check" — the agent
    // said it would do something but hasn't done it yet (in a step with tools)
    const intentWithoutAction = [
      /i('ll| will) (look|check|search|find|get|fetch|retrieve)/,
      /let me (look|check|search|find|get|fetch|retrieve)/,
      /i need to (look|check|search|find)/,
      /i should (look|check|search|find)/,
    ];

    // Only flag this if there are tools available (otherwise the agent can't act)
    if (ctx.toolsAvailable.length > 0) {
      for (const pattern of intentWithoutAction) {
        if (pattern.test(response)) {
          return {
            reason: 'Response expresses intent to act without executing the action',
            suggestedAction: 'use_tool',
          };
        }
      }
    }

    return null;
  }

  private checkForExplicitIncompleteness(ctx: EvaluationContext): HeuristicFailure | null {
    const response = ctx.currentResponse.toLowerCase();

    const incompleteMarkers = [
      "i don't have enough information",
      "i'm unable to",
      'i cannot',
      "i'm not sure",
      "i don't know",
      'more information is needed',
      "i'd need to know",
      'could you clarify',
      'could you provide',
    ];

    for (const marker of incompleteMarkers) {
      if (response.includes(marker)) {
        // Check if the agent has tools that might help before flagging
        if (ctx.toolsAvailable.length > 0 && ctx.toolsUsed.length === 0) {
          // Has tools available but hasn't used any — should try tools first
          return {
            reason: `Response indicates uncertainty but available tools haven't been tried`,
            suggestedAction: 'use_tool',
          };
        }
        return {
          reason: `Response explicitly signals incompleteness: "${marker}"`,
          suggestedAction: 'clarify',
        };
      }
    }

    return null;
  }

  private checkForQuestionWithoutAnswer(ctx: EvaluationContext): HeuristicFailure | null {
    const goal = ctx.originalGoal;
    const response = ctx.currentResponse;

    // Count question marks in the original goal
    const goalQuestions = (goal.match(/\?/g) || []).length;
    if (goalQuestions === 0) return null; // goal isn't a question

    // The response should contain substantive content, not just another question
    const responseHasOnlyQuestions =
      response.trim().endsWith('?') &&
      response.split('.').filter((s) => !s.trim().endsWith('?')).length < 2;

    if (responseHasOnlyQuestions) {
      return {
        reason: 'User asked a question but response only contains questions without answers',
        suggestedAction: 'rethink',
      };
    }

    return null;
  }

  private checkResponseLength(ctx: EvaluationContext): HeuristicFailure | null {
    // Very short responses to complex questions are suspicious
    const goalLength = ctx.originalGoal.length;
    const responseLength = ctx.currentResponse.trim().length;

    // Only flag if: goal is complex (>100 chars), response is tiny (<50 chars),
    // and it's not just a short confirmation task
    const isConfirmationTask = /^(yes|no|done|ok|sure|confirmed|correct)/i.test(
      ctx.currentResponse.trim(),
    );

    if (goalLength > 100 && responseLength < 50 && !isConfirmationTask) {
      return {
        reason: 'Response is suspiciously short for the complexity of the request',
        suggestedAction: 'refine_response',
      };
    }

    return null;
  }

  private checkForErrorSigns(ctx: EvaluationContext): HeuristicFailure | null {
    const response = ctx.currentResponse.toLowerCase();

    const errorSignals = [
      'error occurred',
      'failed to',
      'an error',
      'exception',
      'something went wrong',
      'tool failed',
    ];

    for (const signal of errorSignals) {
      if (response.includes(signal)) {
        return {
          reason: `Response contains error indicators: "${signal}"`,
          suggestedAction: ctx.toolsAvailable.length > 0 ? 'use_tool' : 'rethink',
        };
      }
    }

    return null;
  }
}

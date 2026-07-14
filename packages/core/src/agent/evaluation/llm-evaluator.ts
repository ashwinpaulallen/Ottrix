import type { CompletionProvider } from '../../types/provider.js';
import type {
  EvaluatorStrategy,
  EvaluationContext,
  EvaluationConfig,
  EvaluationObservation,
  SufficiencyResult,
} from './types.js';
import { SufficiencyResultSchema } from './types.js';

export class LLMEvaluator implements EvaluatorStrategy {
  private lastObservation: EvaluationObservation | undefined;

  constructor(
    private provider: CompletionProvider,
    private config: EvaluationConfig,
  ) {}

  getLastObservation(): EvaluationObservation | undefined {
    return this.lastObservation;
  }

  async evaluate(ctx: EvaluationContext): Promise<SufficiencyResult> {
    const messages = this.buildEvaluationMessages(ctx);

    const result = await this.provider.complete({
      messages,
      model: this.config.model, // cheap model if configured
      maxTokens: this.config.maxEvalTokens,
      temperature: 0, // deterministic evaluation
      systemPrompt: this.buildSystemPrompt(ctx),
    });

    this.lastObservation = {
      usedLlm: true,
      tokenUsage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      model: result.model || this.config.model,
    };

    return this.parseResult(result);
  }

  private buildSystemPrompt(ctx: EvaluationContext): string {
    const criteriaBlock = ctx.criteria?.length
      ? `\nEvaluation criteria for this agent:\n${ctx.criteria.map((c) => `- ${c}`).join('\n')}`
      : '';

    const toolsBlock = ctx.toolsAvailable.length
      ? `\nTools available to the agent: ${ctx.toolsAvailable.join(', ')}`
      : '';

    const usedToolsBlock = ctx.toolsUsed.length
      ? `\nTools already called in this run: ${ctx.toolsUsed.join(', ')}`
      : '';

    return `You are a critical evaluator assessing whether an AI agent's response
fully addresses the user's original request.

Be objective and precise. A response is sufficient if it completely and accurately
addresses ALL aspects of the original request. It is insufficient if:
- It misses part of the question
- It gives vague answers where specific ones were needed
- It says "I'll do X" without actually doing X
- It lacks detail that was explicitly requested
${criteriaBlock}${toolsBlock}${usedToolsBlock}

Respond ONLY with a valid JSON object matching the required schema.
Do NOT include markdown fences, explanations, or any text outside the JSON.`;
  }

  private buildEvaluationMessages(
    ctx: EvaluationContext,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    // Build a tight evaluation context — enough to understand the situation,
    // not the full conversation (that would waste tokens).
    // We include: original goal + last 2 assistant turns + current response.

    const recentContext = ctx.conversationHistory
      .filter((m) => m.role === 'assistant')
      .slice(-2)
      .map(
        (m) =>
          `Assistant: ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`,
      )
      .join('\n\n');

    const refinementContext =
      ctx.refinementNumber > 0
        ? `\nThis is refinement attempt ${ctx.refinementNumber} of ${this.config.maxRefinements}.`
        : '';

    const prompt = `Evaluate whether this response fully addresses the user's request.

ORIGINAL REQUEST:
${ctx.originalGoal}

${recentContext ? `RECENT CONTEXT:\n${recentContext}\n` : ''}
RESPONSE TO EVALUATE:
${ctx.currentResponse}
${refinementContext}

Evaluate and return JSON:
{
  "sufficient": boolean,
  "confidence": number between 0 and 1,
  "reason": "one sentence explanation",
  "missingAspects": ["only if insufficient — what is missing"],
  "suggestedAction": "finalize" | "use_tool" | "clarify" | "rethink" | "refine_response",
  "suggestedTool": "tool name if suggestedAction is use_tool, otherwise omit"
}`;

    return [{ role: 'user', content: prompt }];
  }

  private parseResult(result: { content: unknown }): SufficiencyResult {
    let rawText = '';

    try {
      // Handle both string content and ContentBlock arrays
      if (typeof result.content === 'string') {
        rawText = result.content;
      } else if (Array.isArray(result.content)) {
        rawText = result.content
          .filter(
            (b: unknown) =>
              typeof b === 'object' &&
              b !== null &&
              'type' in (b as object) &&
              (b as { type: string }).type === 'text',
          )
          .map((b: unknown) => (b as { text: string }).text)
          .join('');
      }

      // Strip markdown fences if the model wrapped the response anyway
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim();

      const parsed: unknown = JSON.parse(cleaned);
      const validated = SufficiencyResultSchema.safeParse(parsed);

      if (validated.success) {
        return validated.data;
      }

      // Partial parse — if we at least got sufficient: boolean, use that
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { sufficient?: unknown }).sufficient === 'boolean'
      ) {
        const partial = parsed as {
          sufficient: boolean;
          confidence?: number;
          reason?: string;
          missingAspects?: string[];
        };
        return {
          sufficient: partial.sufficient,
          confidence: partial.confidence ?? 0.5,
          reason: partial.reason ?? 'Partial parse',
          missingAspects: partial.missingAspects,
          suggestedAction: 'finalize',
        };
      }

      throw new Error(`Schema validation failed: ${JSON.stringify(validated.error.issues)}`);
    } catch (err) {
      // Fail safe: log the parse error but don't crash the agent run.
      // Assume sufficient to avoid infinite refinement loops on bad evaluator output.
      console.warn(
        '[ottrix:evaluator] Failed to parse evaluation result:',
        err,
        '\nRaw text:',
        rawText,
      );
      return {
        sufficient: true,
        confidence: 0.5,
        reason: 'Evaluation parse error — assuming sufficient',
        suggestedAction: 'finalize',
      };
    }
  }
}

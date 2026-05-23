import type { AgentResult, AgentStep } from '../types/agent.js';
import type { CompletionProvider } from '../types/provider.js';
import { extractTextFromContent } from './messages.js';

/** Evaluation of a single agent step against the goal. */
export interface StepEvaluation {
  /** Whether the step moves toward the goal. */
  onTrack: boolean;
  /** Confidence in the assessment from 0 to 1. */
  confidence: number;
  /** Optional corrective suggestion for the agent. */
  suggestion?: string;
}

/** Evaluation of a completed agent run. */
export interface ResultEvaluation {
  /** Whether the goal appears fully addressed. */
  goalMet: boolean;
  /** Quality score from 0 (poor) to 1 (excellent). */
  quality: number;
  /** Aspects of the goal not yet addressed. */
  missingAspects?: string[];
}

/** Options for {@link Reflector}. */
export interface ReflectorOptions {
  /** LLM used for meta-cognitive evaluation. Required when not in lightweight mode. */
  provider?: CompletionProvider;
  /**
   * When true, use fast heuristics only (no LLM calls).
   * @defaultValue false
   */
  lightweight?: boolean;
  /** System prompt for LLM evaluation calls. */
  evaluationSystemPrompt?: string;
}

const DEFAULT_EVALUATION_SYSTEM_PROMPT = `You evaluate agent progress toward a goal.
Respond with JSON only, no markdown fences.`;

const FINAL_ANSWER_PATTERNS = [
  /\b(in conclusion|to summarize|the answer is|final answer|therefore,?)\b/i,
  /\b(here is|here's|the result is)\b/i,
];

const QUESTION_LIKE_GOAL = /\?|^(what|how|why|when|where|who|which|can|could|should|is|are|do|does)\b/i;

function responseTextFromContent(content: unknown): string {
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : JSON.stringify(text);
  }
  return JSON.stringify(content);
}

/**
 * Evaluates agent progress and result quality (meta-cognition).
 *
 * Supports full LLM-based reflection or a fast lightweight heuristic mode.
 */
export class Reflector {
  private readonly provider?: CompletionProvider;
  private readonly lightweight: boolean;
  private readonly evaluationSystemPrompt: string;

  /**
   * @param options - Provider and lightweight flag.
   */
  constructor(options: ReflectorOptions = {}) {
    this.provider = options.provider;
    this.lightweight = options.lightweight ?? false;
    this.evaluationSystemPrompt = options.evaluationSystemPrompt ?? DEFAULT_EVALUATION_SYSTEM_PROMPT;
  }

  /**
   * Evaluate whether a single step is on track for the goal.
   */
  async evaluateStep(step: AgentStep, goal: string): Promise<StepEvaluation> {
    if (this.lightweight) {
      return evaluateStepLightweight(step, goal);
    }

    if (!this.provider) {
      throw new Error('Reflector requires a CompletionProvider when lightweight mode is disabled');
    }

    const result = await this.provider.complete({
      messages: [
        {
          role: 'user',
          content: `Goal:\n${goal}\n\nStep (${step.type}):\n${JSON.stringify(step.content, null, 2)}`,
        },
      ],
      systemPrompt: `${this.evaluationSystemPrompt}
Return: { "onTrack": boolean, "confidence": number between 0 and 1, "suggestion": optional string }`,
      temperature: 0,
      maxTokens: 512,
    });

    try {
      return parseStepEvaluation(extractTextFromContent(result.content));
    } catch {
      return evaluateStepLightweight(step, goal);
    }
  }

  /**
   * Evaluate whether the final result meets the goal.
   */
  async evaluateResult(result: AgentResult, goal: string): Promise<ResultEvaluation> {
    if (this.lightweight) {
      return evaluateResultLightweight(result, goal);
    }

    if (!this.provider) {
      throw new Error('Reflector requires a CompletionProvider when lightweight mode is disabled');
    }

    const summary = {
      response: result.response,
      stepCount: result.steps.length,
      stepTypes: result.steps.map((s) => s.type),
      stopReason: result.metadata.stopReason,
    };

    const completion = await this.provider.complete({
      messages: [
        {
          role: 'user',
          content: `Goal:\n${goal}\n\nAgent result:\n${JSON.stringify(summary, null, 2)}`,
        },
      ],
      systemPrompt: `${this.evaluationSystemPrompt}
Return: { "goalMet": boolean, "quality": number 0-1, "missingAspects": optional string[] }`,
      temperature: 0,
      maxTokens: 512,
    });

    try {
      return parseResultEvaluation(extractTextFromContent(completion.content));
    } catch {
      return evaluateResultLightweight(result, goal);
    }
  }

  /**
   * Whether the agent should continue working toward the goal.
   */
  async shouldContinue(steps: AgentStep[], goal: string): Promise<boolean> {
    if (this.lightweight) {
      return shouldContinueLightweight(steps, goal);
    }

    if (!this.provider) {
      return shouldContinueLightweight(steps, goal);
    }

    const completion = await this.provider.complete({
      messages: [
        {
          role: 'user',
          content: `Goal:\n${goal}\n\nSteps so far (${steps.length}):\n${summarizeSteps(steps)}`,
        },
      ],
      systemPrompt: `${this.evaluationSystemPrompt}
Return: { "shouldContinue": boolean, "reason": string }`,
      temperature: 0,
      maxTokens: 256,
    });

    const text = extractTextFromContent(completion.content);
    try {
      const parsed = JSON.parse(extractJsonObject(text)) as { shouldContinue?: boolean };
      if (typeof parsed.shouldContinue === 'boolean') {
        return parsed.shouldContinue;
      }
      return shouldContinueLightweight(steps, goal);
    } catch {
      return shouldContinueLightweight(steps, goal);
    }
  }
}

/** Fast heuristic step evaluation (no LLM). */
export function evaluateStepLightweight(step: AgentStep, goal: string): StepEvaluation {
  switch (step.type) {
    case 'tool_call':
    case 'tool_result':
      return { onTrack: true, confidence: 0.7 };
    case 'response': {
      const text = responseTextFromContent(step.content);
      const seemsFinal = FINAL_ANSWER_PATTERNS.some((p) => p.test(text));
      return {
        onTrack: true,
        confidence: seemsFinal ? 0.85 : 0.6,
        suggestion: seemsFinal ? undefined : 'Consider providing a clearer final answer.',
      };
    }
    case 'thinking':
    default:
      return {
        onTrack: goal.length > 0,
        confidence: 0.5,
      };
  }
}

/** Fast heuristic result evaluation (no LLM). */
export function evaluateResultLightweight(result: AgentResult, goal: string): ResultEvaluation {
  const response = result.response.trim();
  const hasSubstance = response.length >= 20;
  const seemsFinal = FINAL_ANSWER_PATTERNS.some((p) => p.test(response));
  const goalMet = hasSubstance && (seemsFinal || !QUESTION_LIKE_GOAL.test(goal));
  const quality = Math.min(1, response.length / 200) * (goalMet ? 1 : 0.5);

  return {
    goalMet,
    quality: Math.round(quality * 100) / 100,
    missingAspects: goalMet ? undefined : ['Response may not fully address the goal'],
  };
}

/** Fast heuristic continue/stop decision (no LLM). */
export function shouldContinueLightweight(steps: AgentStep[], goal: string): boolean {
  if (steps.length === 0) {
    return true;
  }

  const last = steps[steps.length - 1];
  if (last?.type === 'response') {
    const text = responseTextFromContent(last.content);
    if (text.length > 30 && FINAL_ANSWER_PATTERNS.some((p) => p.test(text))) {
      return false;
    }
  }

  const failedTools = steps.filter(
    (s) =>
      s.type === 'tool_result' &&
      typeof s.content === 'object' &&
      s.content !== null &&
      'success' in s.content &&
      (s.content as { success: boolean }).success === false,
  );

  if (failedTools.length >= 2) {
    return false;
  }

  void goal;
  return steps.length < 20;
}

function parseStepEvaluation(text: string): StepEvaluation {
  const parsed = JSON.parse(extractJsonObject(text)) as Partial<StepEvaluation>;
  return {
    onTrack: parsed.onTrack !== false,
    confidence: clamp01(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5),
    suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : undefined,
  };
}

function parseResultEvaluation(text: string): ResultEvaluation {
  const parsed = JSON.parse(extractJsonObject(text)) as Partial<ResultEvaluation>;
  return {
    goalMet: parsed.goalMet === true,
    quality: clamp01(typeof parsed.quality === 'number' ? parsed.quality : 0.5),
    missingAspects: Array.isArray(parsed.missingAspects)
      ? parsed.missingAspects.filter((a): a is string => typeof a === 'string')
      : undefined,
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function summarizeSteps(steps: AgentStep[]): string {
  return steps
    .slice(-5)
    .map((s) => `- [${s.type}] ${JSON.stringify(s.content).slice(0, 200)}`)
    .join('\n');
}

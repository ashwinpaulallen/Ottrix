import type { SufficiencyResult } from './types.js';

export interface RefinementInstruction {
  // The message injected into the conversation to prompt refinement.
  // This is appended to the message history, so the LLM sees the
  // full prior context + this targeted instruction.
  message: string;
  role: 'user'; // always user role — we're continuing the conversation
}

export function buildRefinementInstruction(
  evaluation: SufficiencyResult,
  originalGoal: string,
  _refinementNumber: number,
): RefinementInstruction {
  // Build a targeted instruction based on the suggested action.
  // This is injected as a USER message continuing the thread —
  // the agent sees its own prior response + this critique.

  switch (evaluation.suggestedAction) {
    case 'use_tool': {
      const toolHint = evaluation.suggestedTool
        ? ` Try using the ${evaluation.suggestedTool} tool.`
        : ' Use the available tools to get the information needed.';
      return {
        role: 'user',
        message: `Your response isn't complete yet.${toolHint}\n\nMissing: ${evaluation.reason}`,
      };
    }

    case 'clarify': {
      return {
        role: 'user',
        message: `Your response asks for clarification, but please try to answer with what you currently know. If truly impossible, explain specifically what is needed.\n\nOriginal request: ${originalGoal}`,
      };
    }

    case 'rethink': {
      return {
        role: 'user',
        message: `Your previous approach didn't fully address the request. Please try a different approach.\n\nOriginal request: ${originalGoal}\nWhat was missing: ${evaluation.reason}`,
      };
    }

    case 'refine_response': {
      const missingList = evaluation.missingAspects?.length
        ? `\n\nSpecifically address:\n${evaluation.missingAspects.map((a) => `- ${a}`).join('\n')}`
        : '';
      return {
        role: 'user',
        message: `Your response needs improvement. ${evaluation.reason}${missingList}`,
      };
    }

    case 'finalize':
    default: {
      // This shouldn't happen (finalize means sufficient) but handle defensively
      return {
        role: 'user',
        message: `Please complete your response to address: ${originalGoal}`,
      };
    }
  }
}

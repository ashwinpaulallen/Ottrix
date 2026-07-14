import { describe, expect, it } from 'vitest';
import { buildRefinementInstruction } from '../../../src/agent/evaluation/refinement.js';
import type { SufficiencyResult } from '../../../src/agent/evaluation/types.js';

const originalGoal = 'What is the capital of France and why?';

function evalResult(overrides: Partial<SufficiencyResult> = {}): SufficiencyResult {
  return {
    sufficient: false,
    confidence: 0.8,
    reason: 'Missing key details',
    ...overrides,
  };
}

describe('buildRefinementInstruction', () => {
  it("suggestedAction: 'use_tool' with suggestedTool → mentions the tool name", () => {
    const instruction = buildRefinementInstruction(
      evalResult({
        suggestedAction: 'use_tool',
        suggestedTool: 'search',
        reason: 'Needs lookup',
      }),
      originalGoal,
      1,
    );

    expect(instruction.message).toContain('search');
    expect(instruction.message).toContain('Try using the search tool');
    expect(instruction.message).toContain('Needs lookup');
  });

  it("suggestedAction: 'use_tool' without tool → generic tool hint", () => {
    const instruction = buildRefinementInstruction(
      evalResult({
        suggestedAction: 'use_tool',
        reason: 'Needs lookup',
      }),
      originalGoal,
      1,
    );

    expect(instruction.message).toContain(
      'Use the available tools to get the information needed',
    );
    expect(instruction.message).not.toContain('Try using the');
  });

  it("suggestedAction: 'clarify' → includes original goal", () => {
    const instruction = buildRefinementInstruction(
      evalResult({ suggestedAction: 'clarify' }),
      originalGoal,
      1,
    );

    expect(instruction.message).toContain(originalGoal);
    expect(instruction.message).toContain('clarification');
  });

  it("suggestedAction: 'rethink' → includes reason", () => {
    const instruction = buildRefinementInstruction(
      evalResult({
        suggestedAction: 'rethink',
        reason: 'Approach was off-target',
      }),
      originalGoal,
      1,
    );

    expect(instruction.message).toContain('Approach was off-target');
    expect(instruction.message).toContain('different approach');
    expect(instruction.message).toContain(originalGoal);
  });

  it("suggestedAction: 'refine_response' with missingAspects → lists them", () => {
    const instruction = buildRefinementInstruction(
      evalResult({
        suggestedAction: 'refine_response',
        reason: 'Incomplete answer',
        missingAspects: ['historical context', 'population'],
      }),
      originalGoal,
      1,
    );

    expect(instruction.message).toContain('Incomplete answer');
    expect(instruction.message).toContain('Specifically address:');
    expect(instruction.message).toContain('- historical context');
    expect(instruction.message).toContain('- population');
  });

  it("suggestedAction: 'finalize' (defensive case) → returns safe message", () => {
    const instruction = buildRefinementInstruction(
      evalResult({
        sufficient: true,
        suggestedAction: 'finalize',
      }),
      originalGoal,
      0,
    );

    expect(instruction.message).toContain('Please complete your response');
    expect(instruction.message).toContain(originalGoal);
  });

  it("role is always 'user'", () => {
    const actions: Array<SufficiencyResult['suggestedAction']> = [
      'use_tool',
      'clarify',
      'rethink',
      'refine_response',
      'finalize',
      undefined,
    ];

    for (const suggestedAction of actions) {
      const instruction = buildRefinementInstruction(
        evalResult({ suggestedAction }),
        originalGoal,
        1,
      );
      expect(instruction.role).toBe('user');
    }
  });
});

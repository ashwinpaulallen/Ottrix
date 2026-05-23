import { describe, expect, it, vi } from 'vitest';
import type { AgentStep } from '../../src/types/agent.js';
import {
  createSupervisorThinkingOnStep,
  formatThinkingStep,
} from '../../src/orchestration/thinking.js';

describe('createSupervisorThinkingOnStep', () => {
  it('awaits async onSupervisorThinking before the hook resolves', async () => {
    let finished = false;
    const onSupervisorThinking = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    });

    const onStep = createSupervisorThinkingOnStep(onSupervisorThinking);
    expect(onStep).toBeDefined();

    await onStep?.({
      type: 'thinking',
      timestamp: Date.now(),
      content: { content: 'Planning delegation' },
    });

    expect(onSupervisorThinking).toHaveBeenCalledWith('Planning delegation');
    expect(finished).toBe(true);
  });

  it('awaits an async existing onStep hook', async () => {
    let finished = false;
    const existingOnStep = vi.fn(async (_step: AgentStep) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    });

    const onStep = createSupervisorThinkingOnStep(undefined, existingOnStep);
    await onStep?.({
      type: 'response',
      timestamp: Date.now(),
      content: { text: 'done' },
    });

    expect(existingOnStep).toHaveBeenCalledOnce();
    expect(finished).toBe(true);
  });
});

describe('formatThinkingStep', () => {
  it('extracts plain string thinking content', () => {
    expect(
      formatThinkingStep({
        type: 'thinking',
        timestamp: 1,
        content: { content: 'reasoning' },
      }),
    ).toBe('reasoning');
  });
});

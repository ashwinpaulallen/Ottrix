import type { AgentStep } from '../types/agent.js';
import type { AgentConfig } from '../types/agent.js';

/** Format thinking step content for callbacks and logging. */
export function formatThinkingStep(step: AgentStep): string | undefined {
  const payload = step.content as { content?: unknown };
  if (!payload?.content) {
    return undefined;
  }

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    return payload.content
      .map((block) => {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          return String((block as { text: unknown }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return undefined;
}

/**
 * Compose an {@link AgentConfig.onStep} hook that invokes `onSupervisorThinking`
 * immediately when each supervisor thinking step is recorded (during the run loop).
 */
export function createSupervisorThinkingOnStep(
  onSupervisorThinking?: (content: string) => void | Promise<void>,
  existingOnStep?: AgentConfig['onStep'],
): AgentConfig['onStep'] | undefined {
  if (!onSupervisorThinking && !existingOnStep) {
    return undefined;
  }

  return async (step) => {
    if (existingOnStep) {
      await existingOnStep(step);
    }
    if (step.type !== 'thinking' || !onSupervisorThinking) {
      return;
    }
    const formatted = formatThinkingStep(step);
    if (formatted) {
      await onSupervisorThinking(formatted);
    }
  };
}

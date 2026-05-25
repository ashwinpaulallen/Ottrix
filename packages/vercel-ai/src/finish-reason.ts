import type { LanguageModelV2FinishReason } from '@ai-sdk/provider';

/** Map ottrix stop reasons to Vercel AI SDK finish reasons. */
export function mapStopReasonToFinishReason(stopReason: string): LanguageModelV2FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop':
    case 'completed':
      return 'stop';
    case 'max_tokens':
    case 'length':
      return 'length';
    case 'tool_use':
    case 'tool_calls':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

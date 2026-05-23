import type {
  ChatMessage,
  ContentBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types/messages.js';

/** Extract plain text from message content blocks. */
export function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Extract all `tool_use` blocks from assistant content. */
export function extractToolUses(content: string | ContentBlock[]): ToolUseBlock[] {
  if (typeof content === 'string') {
    return [];
  }
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

/** Whether assistant content is text-only (no tool calls). */
export function isTextOnlyResponse(content: string | ContentBlock[]): boolean {
  return extractToolUses(content).length === 0;
}

/** Serialize tool output for a `tool_result` message. */
export function serializeToolOutput(output: unknown, error?: string): string {
  if (error) {
    return JSON.stringify({ success: false, error });
  }
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Build a `tool_result` content block. */
export function buildToolResultBlock(
  toolUseId: string,
  output: unknown,
  error?: string,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: serializeToolOutput(output, error),
  };
}

/** Build an assistant message from provider content blocks. */
export function buildAssistantMessage(content: ContentBlock[]): ChatMessage {
  return { role: 'assistant', content };
}

/** Build a tool-role message carrying one or more tool results. */
export function buildToolResultsMessage(blocks: ToolResultBlock[]): ChatMessage {
  return { role: 'tool', content: blocks };
}

/** Rough token estimate from serialized messages (chars / 4). */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

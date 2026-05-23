import type { ChatMessage, ContentBlock } from '../types/messages.js';

/** Pluggable token estimator for {@link import('./working.js').WorkingMemory}. */
export interface TokenEstimator {
  /** Estimate tokens for a plain-text string. */
  estimateText(text: string): number;
  /** Estimate tokens for a single chat message. */
  estimateMessage(message: ChatMessage): number;
  /** Estimate tokens for a list of messages. */
  estimateMessages(messages: ChatMessage[]): number;
}

/** Configuration for the default whitespace/punctuation token estimator. */
export interface DefaultTokenEstimatorOptions {
  /**
   * Average tokens per word for English-like text.
   * @defaultValue 1.3
   */
  tokensPerWord?: number;
  /**
   * Fully custom estimator. When set, `tokensPerWord` is ignored.
   */
  estimate?: (text: string) => number;
}

const WORD_PATTERN = /[^\s\p{P}\p{S}]+/gu;

/**
 * Create a token estimator using whitespace/punctuation splitting (~1.3 tokens/word by default).
 */
export function createTokenEstimator(options: DefaultTokenEstimatorOptions = {}): TokenEstimator {
  const tokensPerWord = options.tokensPerWord ?? 1.3;
  const estimateText =
    options.estimate ??
    ((text: string) => {
      const words = text.match(WORD_PATTERN) ?? [];
      return Math.max(1, Math.ceil(words.length * tokensPerWord));
    });

  return {
    estimateText,
    estimateMessage(message: ChatMessage): number {
      return estimateText(messageToText(message));
    },
    estimateMessages(messages: ChatMessage[]): number {
      return messages.reduce((sum, message) => sum + estimateText(messageToText(message)), 0);
    },
  };
}

/** Serialize message content to plain text for estimation and search. */
export function messageToText(message: ChatMessage): string {
  return contentToText(message.content);
}

/** Serialize message content blocks to plain text. */
export function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'tool_use':
        parts.push(`tool_use:${block.name}:${JSON.stringify(block.input)}`);
        break;
      case 'tool_result':
        parts.push(
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        );
        break;
      case 'image':
        parts.push(`[image:${block.source.media_type}]`);
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

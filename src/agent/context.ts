import type { ChatMessage } from '../types/messages.js';
import type { CompletionProvider } from '../types/provider.js';
import { estimateMessageTokens, extractTextFromContent } from './messages.js';

const DEFAULT_CONTEXT_LIMIT = 128_000;
const DEFAULT_KEEP_RECENT = 6;

/**
 * Tracks cumulative token usage and condenses message history when needed.
 */
export class ContextManager {
  private readonly contextLimit: number;
  private readonly keepRecent: number;
  private readonly provider: CompletionProvider;
  private readonly systemPrompt?: string;

  /**
   * @param options - Provider used for token counting and summarization.
   */
  constructor(options: {
    provider: CompletionProvider;
    systemPrompt?: string;
    contextLimitTokens?: number;
    keepRecentMessages?: number;
  }) {
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt;
    this.contextLimit = options.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT;
    this.keepRecent = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT;
  }

  /**
   * If messages approach the context limit, summarize the middle segment.
   *
   * Keeps the system prompt and the last `keepRecentMessages` intact.
   */
  async maybeSummarize(messages: ChatMessage[]): Promise<void> {
    const estimated = await this.safeCountTokens(messages);
    const threshold = Math.floor(this.contextLimit * 0.85);

    if (estimated < threshold) {
      return;
    }

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    if (nonSystem.length <= this.keepRecent + 1) {
      return;
    }

    const recent = nonSystem.slice(-this.keepRecent);
    const middle = nonSystem.slice(0, -this.keepRecent);

    const summaryText = await this.summarizeSegment(middle);
    const summaryMessage: ChatMessage = {
      role: 'user',
      content: `[Conversation summary of earlier turns]\n${summaryText}`,
    };

    messages.length = 0;
    messages.push(...systemMessages, summaryMessage, ...recent);
  }

  private async summarizeSegment(segment: ChatMessage[]): Promise<string> {
    const transcript = segment
      .map((m) => `${m.role}: ${extractTextFromContent(m.content)}`)
      .join('\n');

    const result = await this.provider.complete({
      messages: [
        {
          role: 'user',
          content:
            'Summarize the following conversation segment concisely, preserving key facts, decisions, and tool outcomes:\n\n' +
            transcript,
        },
      ],
      systemPrompt:
        'You produce concise conversation summaries. Output only the summary, no preamble.',
      maxTokens: 1024,
      temperature: 0,
    });

    return extractTextFromContent(result.content);
  }

  private async safeCountTokens(messages: ChatMessage[]): Promise<number> {
    try {
      return await this.provider.countTokens(messages);
    } catch {
      return estimateMessageTokens(messages);
    }
  }
}

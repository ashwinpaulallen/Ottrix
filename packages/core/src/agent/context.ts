import {
  CAPABILITY,
  withCapabilityScope,
} from '../observability/token-accounting/index.js';
import type { ChatMessage } from '../types/messages.js';
import type { CompletionProvider } from '../types/provider.js';
import type { ResolvedCompactionConfig } from './context/compaction-types.js';
import { DigestCache } from './context/digest-cache.js';
import {
  buildProseDigestPrompt,
  buildTopicIndexPrompt,
} from './context/compaction-prompts.js';
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
  private readonly compaction?: ResolvedCompactionConfig;
  private readonly digestCache?: DigestCache;
  private readonly summaryProvider: CompletionProvider;

  /**
   * @param options - Provider used for token counting and summarization.
   * When `compaction` is set, LLM compaction calls use `compaction.provider`
   * (or the primary provider when that is omitted) and `digestCache`.
   */
  constructor(options: {
    provider: CompletionProvider;
    systemPrompt?: string;
    contextLimitTokens?: number;
    keepRecentMessages?: number;
    compaction?: ResolvedCompactionConfig;
    digestCache?: DigestCache;
  }) {
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt;
    this.contextLimit = options.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT;
    this.keepRecent = options.compaction?.recentMessagesToPreserve
      ?? options.keepRecentMessages
      ?? DEFAULT_KEEP_RECENT;
    this.compaction = options.compaction;
    this.digestCache = options.digestCache;
    this.summaryProvider = options.compaction?.provider ?? options.provider;
  }

  /** Resolved compaction config, when the agent was constructed with one. */
  getCompactionConfig(): ResolvedCompactionConfig | undefined {
    return this.compaction;
  }

  /**
   * If messages approach the context limit, summarize the middle segment.
   *
   * Keeps the system prompt and the last `keepRecentMessages` intact.
   * With compaction configured, the hard threshold runs the selected strategy.
   */
  async maybeSummarize(messages: ChatMessage[]): Promise<void> {
    if (this.compaction) {
      await this.maybeCompact(messages);
      return;
    }
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

    const result = await withCapabilityScope(CAPABILITY.SUMMARIZATION, () =>
      this.provider.complete({
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
      }),
    );

    return extractTextFromContent(result.content);
  }

  private async maybeCompact(messages: ChatMessage[]): Promise<void> {
    const compaction = this.compaction;
    if (!compaction) {
      return;
    }

    const estimated = await this.safeCountTokens(messages);
    if (estimated / this.contextLimit < compaction.hardThreshold) {
      return;
    }

    const systemMessages = messages.filter((message) => message.role === 'system');
    const nonSystem = messages.filter((message) => message.role !== 'system');
    if (nonSystem.length <= compaction.recentMessagesToPreserve + 1) {
      return;
    }

    const recent = nonSystem.slice(-compaction.recentMessagesToPreserve);
    const middle = nonSystem.slice(0, -compaction.recentMessagesToPreserve);

    if (compaction.strategy === 'truncate') {
      messages.length = 0;
      messages.push(...systemMessages, ...recent);
      return;
    }

    try {
      const summaryText = await this.compactSegment(middle, compaction);
      const summaryMessage: ChatMessage = {
        role: 'user',
        content: summaryText,
      };
      messages.length = 0;
      messages.push(...systemMessages, summaryMessage, ...recent);
    } catch (error) {
      if (compaction.failurePolicy === 'throw') {
        throw error;
      }
      if (compaction.failurePolicy === 'preserve') {
        return;
      }
      messages.length = 0;
      messages.push(...systemMessages, ...recent);
    }
  }

  private async compactSegment(
    segment: ChatMessage[],
    compaction: ResolvedCompactionConfig,
  ): Promise<string> {
    const folded = segment.map((message) => ({
      role: message.role,
      content: extractTextFromContent(message.content),
    }));
    const hash = DigestCache.hashMessages(folded);
    const cached = this.digestCache?.get(hash);
    if (cached) {
      return formatCompacted(compaction.strategy, cached.topicIndex, cached.digest);
    }

    if (compaction.strategy === 'hierarchical') {
      const topicIndex = extractTextFromContent(
        (
          await this.completeCompaction(
            buildTopicIndexPrompt(folded, { maxTokens: compaction.maxSummaryTokens }),
            compaction,
          )
        ).content,
      );
      const digest = extractTextFromContent(
        (
          await this.completeCompaction(
            buildProseDigestPrompt(folded, topicIndex, { maxTokens: compaction.maxSummaryTokens }),
            compaction,
          )
        ).content,
      );
      this.digestCache?.set(hash, { strategy: 'hierarchical', topicIndex, digest });
      return formatCompacted('hierarchical', topicIndex, digest);
    }

    const digest = extractTextFromContent(
      (
        await this.completeCompaction(
          buildProseDigestPrompt(folded, undefined, { maxTokens: compaction.maxSummaryTokens }),
          compaction,
        )
      ).content,
    );
    this.digestCache?.set(hash, { strategy: 'prose', digest });
    return formatCompacted('prose', undefined, digest);
  }

  private async completeCompaction(prompt: string, compaction: ResolvedCompactionConfig) {
    return withCapabilityScope(CAPABILITY.SUMMARIZATION, () =>
      this.summaryProvider.complete({
        messages: [{ role: 'user', content: prompt }],
        ...(compaction.model ? { model: compaction.model } : {}),
        maxTokens: compaction.maxSummaryTokens,
        temperature: 0,
      }),
    );
  }

  private async safeCountTokens(messages: ChatMessage[]): Promise<number> {
    try {
      return await this.provider.countTokens(messages);
    } catch {
      return estimateMessageTokens(messages);
    }
  }
}

function formatCompacted(
  strategy: ResolvedCompactionConfig['strategy'],
  topicIndex: string | undefined,
  digest: string,
): string {
  if (strategy === 'hierarchical' && topicIndex) {
    return `[Topic index]\n${topicIndex}\n\n[Conversation digest]\n${digest}`;
  }
  return `[Conversation summary of earlier turns]\n${digest}`;
}

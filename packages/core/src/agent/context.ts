import {
  CAPABILITY,
  withCapabilityScope,
} from '../observability/token-accounting/index.js';
import { recordActiveSpanEvent } from '../observability/telemetry.js';
import { Logger } from '../observability/logger.js';
import type { ChatMessage, ContentBlock } from '../types/messages.js';
import type { CompletionProvider } from '../types/provider.js';
import type {
  CompactionTelemetryEvent,
  ResolvedCompactionConfig,
} from './context/compaction-types.js';
import { DigestCache } from './context/digest-cache.js';
import {
  buildOutcomeSummaryText,
  buildProseDigestPrompt,
  buildTopicIndexPrompt,
} from './context/compaction-prompts.js';
import { estimateMessageTokens, extractTextFromContent } from './messages.js';

const DEFAULT_CONTEXT_LIMIT = 128_000;
const DEFAULT_KEEP_RECENT = 6;
const COMPACTED_PREFIX = '<compacted_context>\n[COMPACTED CONTEXT]\n';

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
  private readonly logger = new Logger({ component: 'context' });

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
   * With compaction configured, soft/medium/hard thresholds select the phase.
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

  /** Alias for {@link maybeSummarize} — three-phase entry point. */
  async manageContext(messages: ChatMessage[]): Promise<void> {
    return this.maybeSummarize(messages);
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
    const ratio = estimated / this.contextLimit;

    if (ratio < compaction.softThreshold) {
      return;
    }

    if (ratio < compaction.mediumThreshold) {
      return;
    }

    if (ratio < compaction.hardThreshold) {
      this.applyOutcomeSummaries(messages);
      return;
    }

    const systemMessages = messages.filter((message) => message.role === 'system');
    const nonSystem = messages.filter((message) => message.role !== 'system');
    if (nonSystem.length <= this.keepRecent + 1) {
      return;
    }

    const recent = nonSystem.slice(-this.keepRecent);
    const middle = nonSystem.slice(0, -this.keepRecent);
    const started = Date.now();

    if (compaction.strategy === 'truncate') {
      messages.length = 0;
      messages.push(...systemMessages, ...recent);
      emitCompactionTelemetry({
        trigger: 'hard',
        strategy: 'truncate',
        phase: 'llm_summary',
        foldedMessageCount: middle.length,
        inputTokenEstimate: estimated,
        outputTokenEstimate: 0,
        cacheHit: false,
        fallbackTriggered: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    try {
      const compacted = await this.compactSegment(middle, compaction);
      const summaryMessage: ChatMessage = {
        role: 'assistant',
        content: compacted.text,
      };
      messages.length = 0;
      messages.push(...systemMessages, summaryMessage, ...recent);
      emitCompactionTelemetry({
        trigger: 'hard',
        strategy: compaction.strategy,
        phase: 'llm_summary',
        foldedMessageCount: middle.length,
        inputTokenEstimate: estimated,
        outputTokenEstimate: estimateMessageTokens([summaryMessage]),
        cacheHit: compacted.cacheHit,
        fallbackTriggered: false,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (compaction.failurePolicy === 'throw') {
        throw error;
      }
      if (compaction.failurePolicy === 'preserve') {
        this.logger.warn('Compaction failed; preserving full history', {
          error: error instanceof Error ? error.message : String(error),
        });
        emitCompactionTelemetry({
          trigger: 'hard',
          strategy: compaction.strategy,
          phase: 'llm_summary',
          foldedMessageCount: 0,
          inputTokenEstimate: estimated,
          outputTokenEstimate: 0,
          cacheHit: false,
          fallbackTriggered: true,
          fallbackReason: 'preserve',
          durationMs: Date.now() - started,
        });
        return;
      }
      messages.length = 0;
      messages.push(...systemMessages, ...recent);
      emitCompactionTelemetry({
        trigger: 'hard',
        strategy: compaction.strategy,
        phase: 'llm_summary',
        foldedMessageCount: middle.length,
        inputTokenEstimate: estimated,
        outputTokenEstimate: 0,
        cacheHit: false,
        fallbackTriggered: true,
        fallbackReason: 'truncate',
        durationMs: Date.now() - started,
      });
    }
  }

  private applyOutcomeSummaries(messages: ChatMessage[]): void {
    const systemMessages = messages.filter((message) => message.role === 'system');
    const nonSystem = messages.filter((message) => message.role !== 'system');
    if (nonSystem.length <= this.keepRecent) {
      return;
    }

    const recent = nonSystem.slice(-this.keepRecent);
    const older = nonSystem.slice(0, -this.keepRecent);
    const toolNames = collectToolUseNames(messages);
    let changed = false;
    const summarized = older.map((message) => {
      const next = summarizeToolResultMessage(message, toolNames);
      if (next !== message) {
        changed = true;
      }
      return next;
    });

    if (!changed) {
      return;
    }

    messages.length = 0;
    messages.push(...systemMessages, ...summarized, ...recent);
  }

  private async compactSegment(
    segment: ChatMessage[],
    compaction: ResolvedCompactionConfig,
  ): Promise<{ text: string; cacheHit: boolean }> {
    const folded = segment.map((message) => ({
      role: message.role,
      content: extractFoldedContent(message),
    }));
    const hash = DigestCache.hashMessages(folded);
    const cached = this.digestCache?.get(hash);
    if (cached) {
      return {
        text: formatCompacted(cached.strategy, cached.topicIndex, cached.digest),
        cacheHit: true,
      };
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
      return { text: formatCompacted('hierarchical', topicIndex, digest), cacheHit: false };
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
    return { text: formatCompacted('prose', undefined, digest), cacheHit: false };
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
  const body = strategy === 'hierarchical' && topicIndex ? `${topicIndex}\n\n${digest}` : digest;
  return `${COMPACTED_PREFIX}${body}`;
}

function emitCompactionTelemetry(event: CompactionTelemetryEvent): void {
  recordActiveSpanEvent('ottrix.compaction', {
    trigger: event.trigger,
    strategy: event.strategy,
    phase: event.phase,
    foldedMessageCount: event.foldedMessageCount,
    inputTokenEstimate: event.inputTokenEstimate,
    outputTokenEstimate: event.outputTokenEstimate,
    cacheHit: event.cacheHit,
    fallbackTriggered: event.fallbackTriggered,
    durationMs: event.durationMs,
    ...(event.fallbackReason ? { fallbackReason: event.fallbackReason } : {}),
  });
}

function collectToolUseNames(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
}

function summarizeToolResultMessage(
  message: ChatMessage,
  toolNames: Map<string, string>,
): ChatMessage {
  if (typeof message.content === 'string') {
    return message;
  }

  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== 'tool_result') {
      return block;
    }
    const preview =
      typeof block.content === 'string' ? block.content : extractTextFromContent(block.content);
    if (preview.startsWith("[Tool '")) {
      return block;
    }
    changed = true;
    const name = toolNames.get(block.tool_use_id) ?? 'tool';
    return { ...block, content: buildOutcomeSummaryText(name, preview) };
  });

  return changed ? { ...message, content } : message;
}

function extractFoldedContent(message: ChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .map((block: ContentBlock) => {
      if (block.type === 'text') {
        return block.text;
      }
      if (block.type === 'tool_result') {
        return typeof block.content === 'string'
          ? block.content
          : extractTextFromContent(block.content);
      }
      if (block.type === 'tool_use') {
        return `${block.name}(${JSON.stringify(block.input)})`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

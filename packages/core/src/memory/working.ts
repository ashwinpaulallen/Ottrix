import type { ChatMessage } from '../types/messages.js';
import type { CompletionProvider } from '../types/provider.js';
import type { MemorySnapshot } from '../types/memory.js';
import {
  contentToText,
  createTokenEstimator,
  messageToText,
  type TokenEstimator,
} from './tokens.js';

const SNAPSHOT_VERSION = 1 as const;
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_KEEP_RECENT = 4;
const DEFAULT_RESERVED_RESPONSE = 4_096;
const SUMMARY_TAG = 'workingMemorySummary';

/** Metadata marker for condensed summary system messages. */
export interface WorkingMemorySummaryMeta {
  workingMemorySummary: true;
}

/** Options for {@link WorkingMemory}. */
export interface WorkingMemoryOptions {
  /** Context window size in tokens. @defaultValue 128000 */
  maxTokens?: number;
  /** Tokens reserved for the system prompt. @defaultValue estimated from `systemPrompt` */
  reservedSystemTokens?: number;
  /** Tokens reserved for the model response. @defaultValue 4096 */
  reservedResponseTokens?: number;
  /**
   * Recent messages to keep verbatim during condensation.
   * @defaultValue 4
   */
  keepRecentMessages?: number;
  /** Pluggable token estimator. */
  tokenEstimator?: TokenEstimator;
  /**
   * System prompt text used only for reservation estimates when
   * `reservedSystemTokens` is not set.
   */
  systemPrompt?: string;
  /**
   * When set, exceeded budgets trigger LLM summarization via this provider
   * before falling back to the sliding window.
   */
  summarizationProvider?: CompletionProvider;
}

/**
 * Session-scoped conversation buffer with context-window management.
 *
 * Keeps the system prompt and recent turns, summarizes or drops older content
 * when the estimated token budget is exceeded.
 */
export class WorkingMemory {
  private readonly maxTokens: number;
  private readonly reservedSystemTokens: number;
  private readonly reservedResponseTokens: number;
  private readonly keepRecent: number;
  private readonly tokenEstimator: TokenEstimator;
  private readonly systemPromptText?: string;
  private readonly summarizationProvider?: CompletionProvider;

  private messages: ChatMessage[] = [];

  /**
   * @param options - Context limits, reservations, and token estimation.
   */
  constructor(options: WorkingMemoryOptions = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.reservedResponseTokens = options.reservedResponseTokens ?? DEFAULT_RESERVED_RESPONSE;
    this.keepRecent = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT;
    this.tokenEstimator = options.tokenEstimator ?? createTokenEstimator();
    this.systemPromptText = options.systemPrompt;
    this.summarizationProvider = options.summarizationProvider;

    const systemReserve =
      options.reservedSystemTokens ??
      (options.systemPrompt
        ? this.tokenEstimator.estimateText(options.systemPrompt)
        : 0);
    this.reservedSystemTokens = systemReserve;
  }

  /** Append a message to the session history. */
  addMessage(message: ChatMessage): void {
    this.messages.push(cloneMessage(message));
    this.enforceBudgetSlidingWindow();
  }

  /** Return a shallow copy of the current message list. */
  getMessages(): ChatMessage[] {
    return this.messages.map(cloneMessage);
  }

  /** Estimated total tokens for the current history. */
  getTokenCount(): number {
    return this.tokenEstimator.estimateMessages(this.messages);
  }

  /**
   * Condense older messages into a summary system message.
   *
   * No-op when there is no middle segment to summarize. Does not require the
   * budget to be exceeded.
   */
  async summarize(provider?: CompletionProvider): Promise<void> {
    const summarizer = provider ?? this.summarizationProvider;
    if (!summarizer) {
      throw new Error(
        'WorkingMemory.summarize requires a CompletionProvider argument or summarizationProvider in options',
      );
    }
    await this.condenseWithSummarization(summarizer);
    this.enforceBudgetSlidingWindow();
  }

  /** Remove all messages. */
  clear(): void {
    this.messages = [];
  }

  /** Capture serializable state for persistence. */
  snapshot(): MemorySnapshot {
    return {
      version: SNAPSHOT_VERSION,
      messages: this.getMessages(),
      createdAt: Date.now(),
    };
  }

  /** Restore state from a prior {@link snapshot}. */
  restore(snapshot: MemorySnapshot): void {
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw new Error(`Unsupported MemorySnapshot version: ${String(snapshot.version)}`);
    }
    this.messages = snapshot.messages.map(cloneMessage);
  }

  /**
   * Case-insensitive keyword search over message text.
   *
   * @returns Messages whose text content contains every whitespace-separated keyword.
   */
  findMessages(query: string): ChatMessage[] {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (keywords.length === 0) {
      return [];
    }

    return this.messages.filter((message) => {
      const text = messageToText(message).toLowerCase();
      return keywords.every((keyword) => text.includes(keyword));
    });
  }

  /** Tokens available for message history after reservations. */
  getAvailableTokenBudget(): number {
    return Math.max(
      0,
      this.maxTokens - this.reservedSystemTokens - this.reservedResponseTokens,
    );
  }

  private enforceBudgetSlidingWindow(): void {
    let previousLength = -1;
    while (
      this.getTokenCount() > this.getAvailableTokenBudget() &&
      this.messages.length !== previousLength
    ) {
      previousLength = this.messages.length;
      this.condenseWithSlidingWindow();
    }
  }

  private async condenseWithSummarization(provider: CompletionProvider): Promise<void> {
    const { primarySystem, summarySystem, conversation } = this.partitionMessages();

    if (conversation.length <= this.keepRecent) {
      return;
    }

    const recent = conversation.slice(-this.keepRecent);
    const middle = conversation.slice(0, -this.keepRecent);

    if (middle.length === 0) {
      return;
    }

    const summaryText = await this.generateSummary(provider, middle, summarySystem);
    const newSummary = {
      role: 'system',
      content: `[Conversation summary]\n${summaryText}`,
      metadata: { workingMemorySummary: true },
    } as unknown as ChatMessage;

    this.messages = [...primarySystem, newSummary, ...recent.map(cloneMessage)];
  }

  private condenseWithSlidingWindow(): void {
    const { primarySystem, summarySystem, conversation } = this.partitionMessages();

    let summaries = [...summarySystem];
    let recent = conversation.slice(-this.keepRecent);
    let middle = conversation.slice(0, -this.keepRecent);

    if (middle.length > 0) {
      middle = middle.slice(1);
    } else if (summaries.length > 0) {
      summaries = summaries.slice(1);
    } else if (recent.length > 1) {
      recent = recent.slice(1);
    } else {
      return;
    }

    this.messages = [
      ...primarySystem.map(cloneMessage),
      ...summaries.map(cloneMessage),
      ...middle.map(cloneMessage),
      ...recent.map(cloneMessage),
    ];
  }

  private partitionMessages(): {
    primarySystem: ChatMessage[];
    summarySystem: ChatMessage[];
    conversation: ChatMessage[];
  } {
    const primarySystem: ChatMessage[] = [];
    const summarySystem: ChatMessage[] = [];
    const conversation: ChatMessage[] = [];

    for (const message of this.messages) {
      if (message.role === 'system' && isSummaryMessage(message)) {
        summarySystem.push(message);
        continue;
      }
      if (message.role === 'system' && primarySystem.length === 0) {
        primarySystem.push(message);
        continue;
      }
      if (message.role === 'system') {
        summarySystem.push(message);
        continue;
      }
      conversation.push(message);
    }

    if (primarySystem.length === 0 && this.systemPromptText) {
      primarySystem.push({ role: 'system', content: this.systemPromptText });
    }

    return { primarySystem, summarySystem, conversation };
  }

  private async generateSummary(
    provider: CompletionProvider,
    middle: ChatMessage[],
    priorSummaries: ChatMessage[],
  ): Promise<string> {
    const segments: string[] = [];

    for (const summary of priorSummaries) {
      segments.push(`Prior summary:\n${messageToText(summary)}`);
    }

    segments.push(
      middle.map((m) => `${m.role}: ${messageToText(m)}`).join('\n'),
    );

    const result = await provider.complete({
      messages: [
        {
          role: 'user',
          content:
            'Summarize the following conversation segment concisely. Preserve key facts, decisions, and tool outcomes:\n\n' +
            segments.join('\n\n'),
        },
      ],
      systemPrompt:
        'You produce concise conversation summaries. Output only the summary, no preamble.',
      maxTokens: 1024,
      temperature: 0,
    });

    return contentToText(result.content);
  }
}

function isSummaryMessage(message: ChatMessage): boolean {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  return metadata?.[SUMMARY_TAG] === true;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  const cloned: ChatMessage = {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : structuredClone(message.content),
  };
  if (message.metadata !== undefined && typeof message.metadata === 'object') {
    cloned.metadata = structuredClone(message.metadata);
  }
  return cloned;
}

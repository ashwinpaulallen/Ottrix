import { randomUUID } from 'node:crypto';

import { parseAndValidateStructuredOutput } from '../agent/structured-output.js';
import type { ChatMessage } from '../types/messages.js';
import type { CompletionProvider } from '../types/provider.js';
import { messageToText } from './tokens.js';

/** Category of a persisted user observation. */
export type ObservationCategory = 'preference' | 'fact' | 'behavior' | 'context' | 'instruction';

/** How an observation was recorded. */
export type ObservationSource = 'extracted' | 'explicit';

/** A single fact, preference, or contextual note about the user. */
export interface Observation {
  id: string;
  category: ObservationCategory;
  content: string;
  confidence: number;
  source: ObservationSource;
  createdAt: number;
  updatedAt: number;
  generation: number;
  supersedes?: string;
}

/** Filter for {@link ObservationalMemory.getObservations}. */
export interface ObservationFilter {
  category?: ObservationCategory;
}

/** When automatic extraction runs after agent turns. */
export type ExtractionInterval = 'every_turn' | 'every_n_turns' | 'on_demand';

/** Persistence backend for observations. */
export interface ObservationStore {
  save(observation: Observation): Promise<void>;
  getAll(): Promise<Observation[]>;
  getByCategory(category: string): Promise<Observation[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Options for {@link ObservationalMemory}. */
export interface ObservationalMemoryOptions {
  provider: CompletionProvider;
  store: ObservationStore;
  extractionModel?: string;
  maxObservationsInContext?: number;
  extractionInterval?: ExtractionInterval;
  extractionN?: number;
}

/** In-memory {@link ObservationStore} for development and tests. */
export class InMemoryObservationStore implements ObservationStore {
  private readonly observations = new Map<string, Observation>();

  /** @inheritdoc */
  save(observation: Observation): Promise<void> {
    this.observations.set(observation.id, observation);
    return Promise.resolve();
  }

  /** @inheritdoc */
  getAll(): Promise<Observation[]> {
    return Promise.resolve([...this.observations.values()]);
  }

  /** @inheritdoc */
  getByCategory(category: string): Promise<Observation[]> {
    return Promise.resolve(
      [...this.observations.values()].filter((obs) => obs.category === category),
    );
  }

  /** @inheritdoc */
  delete(id: string): Promise<void> {
    this.observations.delete(id);
    return Promise.resolve();
  }

  /** @inheritdoc */
  clear(): Promise<void> {
    this.observations.clear();
    return Promise.resolve();
  }
}

const DEFAULT_MAX_OBSERVATIONS_IN_CONTEXT = 20;

const CATEGORY_PRIORITY: Record<ObservationCategory, number> = {
  preference: 0,
  fact: 1,
  context: 2,
  behavior: 3,
  instruction: 4,
};

const EXTRACTION_SYSTEM_PROMPT = `Extract notable facts, preferences, and context about the user from this conversation.
Return a JSON object with an "observations" array. Each observation must have: category, content, confidence.
Categories: preference, fact, behavior, context, instruction.
Only extract things that would be useful to remember for future conversations.
Do NOT extract transient information (what they're currently working on unless it's a preference).
Examples: "User prefers TypeScript over JavaScript", "User works at Acme Corp",
"User is based in Chennai", "User prefers concise responses".
Respond with ONLY valid JSON matching the schema.`;

const CONTRADICTION_SYSTEM_PROMPT =
  'Determine whether two user observations contradict each other. Respond with ONLY valid JSON.';

/**
 * Automatic fact extraction and personalization layer.
 *
 * Extracts durable user observations from conversations, deduplicates and
 * resolves contradictions, and injects known facts into the system prompt.
 */
export class ObservationalMemory {
  private readonly provider: CompletionProvider;
  private readonly store: ObservationStore;
  private readonly extractionModel?: string;
  private readonly maxObservationsInContext: number;
  private readonly extractionInterval: ExtractionInterval;
  private readonly extractionN: number;
  private turnCount = 0;

  /**
   * @param options - Provider, store, and extraction policy.
   */
  constructor(options: ObservationalMemoryOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.extractionModel = options.extractionModel;
    this.maxObservationsInContext =
      options.maxObservationsInContext ?? DEFAULT_MAX_OBSERVATIONS_IN_CONTEXT;
    this.extractionInterval = options.extractionInterval ?? 'every_turn';
    this.extractionN = Math.max(1, options.extractionN ?? 1);
  }

  /** Increment the run counter (called by the agent after each run). */
  notifyRunCompleted(): void {
    this.turnCount += 1;
  }

  /** Whether automatic extraction should run for the latest completed turn. */
  shouldAutoExtract(): boolean {
    if (this.extractionInterval === 'on_demand') {
      return false;
    }
    if (this.extractionInterval === 'every_turn') {
      return true;
    }
    return this.turnCount % this.extractionN === 0;
  }

  /**
   * Extract observations from conversation messages using the configured provider.
   */
  async extractFromMessages(messages: ChatMessage[]): Promise<Observation[]> {
    const extractable = messages.filter((message) =>
      message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
    );
    if (extractable.length === 0) {
      return [];
    }

    const extracted = await this.callExtractionModel(extractable);
    const saved: Observation[] = [];

    for (const candidate of extracted) {
      const merged = await this.mergeCandidate(candidate);
      saved.push(merged);
    }

    return saved;
  }

  /**
   * Append known observations to a system prompt in a structured section.
   */
  async injectIntoContext(systemPrompt: string): Promise<string> {
    const observations = await this.store.getAll();
    if (observations.length === 0) {
      return systemPrompt;
    }

    const selected = observations
      .sort(compareObservationsForContext)
      .slice(0, this.maxObservationsInContext);

    const lines = selected.map((obs) => `- ${obs.content}`).join('\n');
    const section = `\n\n## Known information about this user:\n${lines}`;

    if (!systemPrompt.trim()) {
      return section.trimStart();
    }
    return `${systemPrompt.trim()}${section}`;
  }

  /** Manually record an observation with full confidence. */
  async addExplicitObservation(
    content: string,
    category: ObservationCategory,
  ): Promise<Observation> {
    const existing = await this.store.getByCategory(category);
    for (const obs of existing) {
      if (keywordOverlap(obs.content, content) > 0.6) {
        const updated = createObservation({
          id: obs.id,
          category: obs.category,
          content,
          confidence: 1,
          source: 'explicit',
          createdAt: obs.createdAt,
          generation: obs.generation + 1,
          supersedes: obs.supersedes,
        });
        await this.store.save(updated);
        return updated;
      }
    }

    const observation = createObservation({
      category,
      content,
      confidence: 1,
      source: 'explicit',
    });
    await this.store.save(observation);
    return observation;
  }

  /** List stored observations, optionally filtered by category. */
  async getObservations(filter?: ObservationFilter): Promise<Observation[]> {
    const all = await this.store.getAll();
    if (!filter?.category) {
      return all;
    }
    return all.filter((obs) => obs.category === filter.category);
  }

  /** Remove an observation by id. */
  async removeObservation(id: string): Promise<void> {
    await this.store.delete(id);
  }

  private async callExtractionModel(
    messages: ChatMessage[],
  ): Promise<Array<{ category: ObservationCategory; content: string; confidence: number }>> {
    const { z } = await import('zod');
    const schema = z.object({
      observations: z.array(
        z.object({
          category: z.enum(['preference', 'fact', 'behavior', 'context', 'instruction']),
          content: z.string().min(1),
          confidence: z.number().min(0).max(1),
        }),
      ),
    });

    const conversation = messages
      .map((message) => `${message.role}: ${messageToText(message)}`)
      .join('\n\n');

    const result = await this.provider.complete({
      model: this.extractionModel,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: conversation },
      ],
      temperature: 0,
      maxTokens: 2_048,
    });

    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const parsed = parseAndValidateStructuredOutput(text, schema);
    if (!parsed.success) {
      return [];
    }

    const data = parsed.data as {
      observations: Array<{
        category: ObservationCategory;
        content: string;
        confidence: number;
      }>;
    };
    return data.observations;
  }

  private async mergeCandidate(candidate: {
    category: ObservationCategory;
    content: string;
    confidence: number;
  }): Promise<Observation> {
    const existing = await this.store.getByCategory(candidate.category);

    for (const obs of existing) {
      const overlap = keywordOverlap(obs.content, candidate.content);
      if (overlap > 0.6) {
        const contradicts = await this.detectContradiction(obs.content, candidate.content);
        if (contradicts) {
          const replacement = createObservation({
            category: candidate.category,
            content: candidate.content,
            confidence: candidate.confidence,
            source: 'extracted',
            supersedes: obs.id,
          });
          await this.store.delete(obs.id);
          await this.store.save(replacement);
          return replacement;
        }

        const updated = createObservation({
          id: obs.id,
          category: obs.category,
          content: candidate.content,
          confidence: Math.max(obs.confidence, candidate.confidence),
          source: obs.source === 'explicit' ? 'explicit' : 'extracted',
          createdAt: obs.createdAt,
          generation: obs.generation + 1,
          supersedes: obs.supersedes,
        });
        await this.store.save(updated);
        return updated;
      }

      const contradicts = await this.detectContradiction(obs.content, candidate.content);
      if (contradicts) {
        const replacement = createObservation({
          category: candidate.category,
          content: candidate.content,
          confidence: candidate.confidence,
          source: 'extracted',
          supersedes: obs.id,
        });
        await this.store.delete(obs.id);
        await this.store.save(replacement);
        return replacement;
      }
    }

    const observation = createObservation({
      category: candidate.category,
      content: candidate.content,
      confidence: candidate.confidence,
      source: 'extracted',
    });
    await this.store.save(observation);
    return observation;
  }

  private async detectContradiction(existing: string, incoming: string): Promise<boolean> {
    const { z } = await import('zod');
    const schema = z.object({ contradicts: z.boolean() });

    const result = await this.provider.complete({
      model: this.extractionModel,
      messages: [
        { role: 'system', content: CONTRADICTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Observation A: ${existing}\nObservation B: ${incoming}`,
        },
      ],
      temperature: 0,
      maxTokens: 256,
    });

    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const parsed = parseAndValidateStructuredOutput(text, schema);
    if (!parsed.success) {
      return false;
    }
    return (parsed.data as { contradicts: boolean }).contradicts;
  }
}

function createObservation(
  partial: {
    category: ObservationCategory;
    content: string;
    confidence: number;
    source?: ObservationSource;
    id?: string;
    createdAt?: number;
    generation?: number;
    supersedes?: string;
  },
): Observation {
  const now = Date.now();
  return {
    id: partial.id ?? randomUUID(),
    category: partial.category,
    content: partial.content,
    confidence: partial.confidence,
    source: partial.source ?? 'extracted',
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
    generation: partial.generation ?? 1,
    supersedes: partial.supersedes,
  };
}

function compareObservationsForContext(a: Observation, b: Observation): number {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
}

/** Jaccard similarity over lowercased word tokens. @internal */
export function keywordOverlap(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[^\s\p{P}\p{S}]+/gu) ?? []);
}

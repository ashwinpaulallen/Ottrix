import { Injectable } from '@nestjs/common';
import { WorkingMemory, type MemorySnapshot, type WorkingMemoryOptions } from 'ottrix';

/** Persist and restore {@link WorkingMemory} snapshots keyed by session id. */
export interface SessionMemoryStore {
  get(sessionId: string): Promise<MemorySnapshot | undefined>;
  set(sessionId: string, snapshot: MemorySnapshot): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/** In-memory session store for development and single-instance deployments. */
export class InMemorySessionMemoryStore implements SessionMemoryStore {
  private readonly snapshots = new Map<string, MemorySnapshot>();

  get(sessionId: string): Promise<MemorySnapshot | undefined> {
    return Promise.resolve(this.snapshots.get(sessionId));
  }

  set(sessionId: string, snapshot: MemorySnapshot): Promise<void> {
    this.snapshots.set(sessionId, snapshot);
    return Promise.resolve();
  }

  delete(sessionId: string): Promise<void> {
    this.snapshots.delete(sessionId);
    return Promise.resolve();
  }
}

/** Options for {@link SessionMemoryService}. */
export interface SessionMemoryServiceOptions {
  store?: SessionMemoryStore;
  /** Defaults applied when creating a new {@link WorkingMemory} per session. */
  workingMemory?: WorkingMemoryOptions;
}

/**
 * HTTP session-scoped conversation memory backed by {@link WorkingMemory}.
 *
 * Use with {@link createChatPipeline} or inject via {@link InjectSessionMemory}.
 */
@Injectable()
export class SessionMemoryService {
  private readonly store: SessionMemoryStore;
  private readonly workingMemoryDefaults: WorkingMemoryOptions;
  private readonly active = new Map<string, WorkingMemory>();

  constructor(options: SessionMemoryServiceOptions = {}) {
    this.store = options.store ?? new InMemorySessionMemoryStore();
    this.workingMemoryDefaults = options.workingMemory ?? {};
  }

  /** Load or create working memory for a session. */
  async getOrCreate(sessionId: string): Promise<WorkingMemory> {
    const cached = this.active.get(sessionId);
    if (cached) {
      return cached;
    }

    const memory = new WorkingMemory(this.workingMemoryDefaults);
    const snapshot = await this.store.get(sessionId);
    if (snapshot) {
      memory.restore(snapshot);
    }

    this.active.set(sessionId, memory);
    return memory;
  }

  /** Append a user/assistant turn and persist the session snapshot. */
  async recordTurn(sessionId: string, userMessage: string, assistantMessage: string): Promise<void> {
    const memory = await this.getOrCreate(sessionId);
    memory.addMessage({ role: 'user', content: userMessage });
    memory.addMessage({ role: 'assistant', content: assistantMessage });
    await this.store.set(sessionId, memory.snapshot());
  }

  /** Persist the current in-memory session state. */
  async persist(sessionId: string): Promise<void> {
    const memory = this.active.get(sessionId);
    if (!memory) {
      return;
    }
    await this.store.set(sessionId, memory.snapshot());
  }

  /** Remove a session from memory and the backing store. */
  async clear(sessionId: string): Promise<void> {
    this.active.delete(sessionId);
    await this.store.delete(sessionId);
  }
}

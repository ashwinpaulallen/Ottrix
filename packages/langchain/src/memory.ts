import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';
import type { WorkingMemory } from 'ottrix';

import { langChainMessageToOttrix, ottrixMessagesToLangChain } from './messages.js';

/** Bridges ottrix {@link WorkingMemory} into LangChain chat history. */
export class OttrixMemoryAdapter extends BaseChatMessageHistory {
  lc_namespace = ['ottrix', 'langchain', 'memory'];

  constructor(private readonly memory: WorkingMemory) {
    super({});
  }

  async getMessages(): Promise<BaseMessage[]> {
    return ottrixMessagesToLangChain(this.memory.getMessages());
  }

  async addMessage(message: BaseMessage): Promise<void> {
    this.memory.addMessage(langChainMessageToOttrix(message));
  }

  async addUserMessage(message: string): Promise<void> {
    this.memory.addMessage({ role: 'user', content: message });
  }

  async addAIMessage(message: string): Promise<void> {
    this.memory.addMessage({ role: 'assistant', content: message });
  }

  async clear(): Promise<void> {
    this.memory.clear();
  }
}

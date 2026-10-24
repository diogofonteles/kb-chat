import type { Conversation } from '@kb-chat/contracts';
import type { ConversationStorePort } from '../ports/conversation-store.js';

interface Entry {
  readonly principal: string;
  readonly conversation: Conversation;
}

/** Conversations kept in memory (tests and runs without a state folder). */
export class MemoryConversationStore implements ConversationStorePort {
  private readonly entries = new Map<string, Entry>();

  async list(principal: string): Promise<Conversation[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.principal === principal)
      .map((entry) => entry.conversation);
  }

  async get(principal: string, id: string): Promise<Conversation | null> {
    const entry = this.entries.get(id);
    return entry?.principal === principal ? entry.conversation : null;
  }

  async put(principal: string, conversation: Conversation): Promise<void> {
    this.entries.set(conversation.id, { principal, conversation });
  }

  async remove(principal: string, id: string): Promise<boolean> {
    if (this.entries.get(id)?.principal !== principal) return false;
    return this.entries.delete(id);
  }
}

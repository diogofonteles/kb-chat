import type { Conversation } from '@kb-chat/contracts';

/**
 * Every saved conversation, without a cap (owner, 2026-10-24). Keyed by principal from
 * day one (ADR 0005): a conversation is only listed, read or removed by whoever saved it.
 */
export interface ConversationStorePort {
  list(principal: string): Promise<Conversation[]>;
  get(principal: string, id: string): Promise<Conversation | null>;
  /** Creates or replaces the conversation with the same id. */
  put(principal: string, conversation: Conversation): Promise<void>;
  /** Returns false when there was nothing to remove. */
  remove(principal: string, id: string): Promise<boolean>;
}

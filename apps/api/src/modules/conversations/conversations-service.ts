import {
  summarizeConversation,
  type Conversation,
  type ConversationKind,
  type ConversationSummary,
} from '@kb-chat/contracts';
import type { ConversationStorePort } from '../../ports/conversation-store.js';

export interface ConversationFilter {
  readonly kind?: ConversationKind;
  readonly topic?: string;
}

export interface ConversationsServiceDeps {
  readonly store: ConversationStorePort;
}

const matches = (summary: ConversationSummary, filter: ConversationFilter) =>
  (filter.kind === undefined || summary.kind === filter.kind) &&
  (filter.topic === undefined || summary.topic === filter.topic);

/** Newest first; equal timestamps keep a stable order by id. */
const byNewest = (a: ConversationSummary, b: ConversationSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/**
 * The complete conversation history kept on this computer (no cap), per principal: each
 * person only lists, reads and removes their own (KBC-010 BR-6).
 */
export class ConversationsService {
  constructor(private readonly deps: ConversationsServiceDeps) {}

  async list(
    principal: string,
    filter: ConversationFilter = {},
  ): Promise<ConversationSummary[]> {
    const all = await this.deps.store.list(principal);
    return all
      .map(summarizeConversation)
      .filter((summary) => matches(summary, filter))
      .sort(byNewest);
  }

  get(principal: string, id: string): Promise<Conversation | null> {
    return this.deps.store.get(principal, id);
  }

  async save(
    principal: string,
    conversation: Conversation,
  ): Promise<ConversationSummary> {
    await this.deps.store.put(principal, conversation);
    return summarizeConversation(conversation);
  }

  remove(principal: string, id: string): Promise<boolean> {
    return this.deps.store.remove(principal, id);
  }
}

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
  /** Who owns the conversations (ADR 0005: the owner until release 2 adds logins). */
  readonly principal: string;
}

const matches = (summary: ConversationSummary, filter: ConversationFilter) =>
  (filter.kind === undefined || summary.kind === filter.kind) &&
  (filter.topic === undefined || summary.topic === filter.topic);

/** Newest first; equal timestamps keep a stable order by id. */
const byNewest = (a: ConversationSummary, b: ConversationSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/** The complete conversation history kept on this computer (no cap). */
export class ConversationsService {
  constructor(private readonly deps: ConversationsServiceDeps) {}

  async list(filter: ConversationFilter = {}): Promise<ConversationSummary[]> {
    const all = await this.deps.store.list(this.deps.principal);
    return all
      .map(summarizeConversation)
      .filter((summary) => matches(summary, filter))
      .sort(byNewest);
  }

  get(id: string): Promise<Conversation | null> {
    return this.deps.store.get(this.deps.principal, id);
  }

  async save(conversation: Conversation): Promise<ConversationSummary> {
    await this.deps.store.put(this.deps.principal, conversation);
    return summarizeConversation(conversation);
  }

  remove(id: string): Promise<boolean> {
    return this.deps.store.remove(this.deps.principal, id);
  }
}

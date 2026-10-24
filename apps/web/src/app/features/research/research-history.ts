import { InjectionToken } from '@angular/core';
import type { Conversation } from '@kb-chat/contracts';

export type ResearchConversation = Extract<Conversation, { kind: 'research' }>;

/** Saves (creates or replaces by id) a research conversation in the history (FR-6). */
export type SaveResearch = (conversation: ResearchConversation) => void;

/**
 * The single place where the research store reaches the history. The default keeps the
 * conversation on screen only: the browser history (core/history) still stores the search
 * shape, and writing another shape there would make it unreadable. The server-side history
 * binds this token to its `save(conversation)`.
 */
export const SAVE_RESEARCH = new InjectionToken<SaveResearch>('SAVE_RESEARCH', {
  providedIn: 'root',
  factory: () => () => undefined,
});

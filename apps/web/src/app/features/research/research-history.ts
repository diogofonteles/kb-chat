import { InjectionToken, inject } from '@angular/core';
import type { Conversation } from '@kb-chat/contracts';
import { HistoryStore } from '@core/history/history-store.js';

export type ResearchConversation = Extract<Conversation, { kind: 'research' }>;

/** Saves (creates or replaces by id) a research conversation in the history (FR-6). */
export type SaveResearch = (conversation: ResearchConversation) => void;

/** The single place where the research store reaches the server-side history. */
export const SAVE_RESEARCH = new InjectionToken<SaveResearch>('SAVE_RESEARCH', {
  providedIn: 'root',
  factory: () => {
    const history = inject(HistoryStore);
    return (conversation) => history.save(conversation);
  },
});

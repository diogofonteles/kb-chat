import { InjectionToken, inject } from '@angular/core';
import type { Conversation } from '@kb-chat/contracts';
import { HistoryStore } from '@core/history/history-store.js';
import type { Observable } from 'rxjs';

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

/** Reads a conversation back from the history (KBC-029: a turn to follow after a reload). */
export type LoadConversation = (id: string) => Observable<Conversation>;

export const LOAD_CONVERSATION = new InjectionToken<LoadConversation>(
  'LOAD_CONVERSATION',
  {
    providedIn: 'root',
    factory: () => {
      const history = inject(HistoryStore);
      return (id) => history.load(id);
    },
  },
);

import { InjectionToken } from '@angular/core';
import type { ResearchConversation } from '@kb-chat/contracts';

/**
 * Seam for "Pesquisa com IA" conversations in the history (KBC-008 FR-6, AC-9).
 *
 * The side panel loads the full conversation from the API and hands it here; the research
 * view shows the saved answers and sources and never calls the AI again. Until that view
 * exists the default does nothing. The research view provides it where the side panel can
 * see it (the chat page or its route), e.g.
 * `{ provide: RESEARCH_RESTORER, useExisting: ResearchStore }`.
 */
export interface ResearchRestorer {
  restore(conversation: ResearchConversation): void;
}

const NO_RESEARCH_RESTORER: ResearchRestorer = { restore: () => undefined };

export const RESEARCH_RESTORER = new InjectionToken<ResearchRestorer>(
  'kb-chat.research-restorer',
  { providedIn: 'root', factory: () => NO_RESEARCH_RESTORER },
);

import type { Provider, ProviderToken } from '@angular/core';
import type { ResearchConversation } from './research-history.js';
import { ResearchStore } from './research-store.js';

/** What the history needs to bring a research conversation back (FR-6). */
export interface ResearchRestoring {
  restore(conversation: ResearchConversation): void;
}

/**
 * Binds the history's restorer token to the page's ResearchStore. Register it in the chat
 * page's `providers`, next to ResearchStore (both page-scoped), e.g.
 * `provideResearchRestorer(ResearchRestorer)`.
 */
export function provideResearchRestorer(
  token: ProviderToken<ResearchRestoring>,
): Provider {
  return { provide: token, useExisting: ResearchStore };
}

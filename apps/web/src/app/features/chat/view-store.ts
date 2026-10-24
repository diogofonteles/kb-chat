import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { SpendStore } from '@core/spend/spend-store.js';

/** The two views of the page (KBC-008): the free search engine and the research agent. */
export type ChatView = 'search' | 'research';

const STORAGE_KEY = 'kb-chat.view';
const VIEWS: readonly ChatView[] = ['search', 'research'];

/** Storage may be blocked (private mode, site data off): the choice then lasts for this page only. */
function readView(window: Window | null): ChatView | null {
  try {
    const stored = window?.localStorage.getItem(STORAGE_KEY);
    return VIEWS.find((view) => view === stored) ?? null;
  } catch {
    return null;
  }
}

function writeView(window: Window | null, view: ChatView): void {
  try {
    window?.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Storage unavailable: nothing to remember.
  }
}

/**
 * The current view, remembered in the browser (FR-5). Without an AI provider only the search
 * view exists; with one, a reader who never chose starts in the research view.
 */
@Injectable()
export class ViewStore {
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly spend = inject(SpendStore);
  private readonly chosen = signal<ChatView | null>(readView(this.window));

  /** True while today's spend is loading or unreadable: the API answers for itself then. */
  readonly researchAvailable = this.spend.configured;
  readonly current = computed<ChatView>(() =>
    this.researchAvailable() ? (this.chosen() ?? 'research') : 'search',
  );

  select(view: ChatView): void {
    if (view === 'research' && !this.researchAvailable()) return;
    this.chosen.set(view);
    writeView(this.window, view);
  }
}

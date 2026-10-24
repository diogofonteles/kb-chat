import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { SpendStore } from '@core/spend/spend-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import {
  readViewPreference,
  writeViewPreference,
  type ChatView,
} from './view-preference.js';

export type { ChatView } from './view-preference.js';

/** localStorage access itself can throw (blocked site data). */
function safeStorage(view: Window | null): Storage | undefined {
  try {
    return view?.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The current view, remembered in the browser (FR-5). Without an AI provider only the search
 * view exists; with one, a reader who never chose in this browser starts in the default
 * view of their Settings (KBC-007), else in the research view.
 */
@Injectable()
export class ViewStore {
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);
  private readonly spend = inject(SpendStore);
  private readonly settings = inject(SettingsStore);
  private readonly chosen = signal<ChatView | null>(
    readViewPreference(this.storage),
  );
  private readonly preferred = computed<ChatView>(
    () => this.settings.settings()?.preferences.defaultView ?? 'research',
  );

  /** True while today's spend is loading or unreadable: the API answers for itself then. */
  readonly researchAvailable = this.spend.configured;
  readonly current = computed<ChatView>(() =>
    this.researchAvailable() ? (this.chosen() ?? this.preferred()) : 'search',
  );

  select(view: ChatView): void {
    if (view === 'research' && !this.researchAvailable()) return;
    this.chosen.set(view);
    writeViewPreference(this.storage, view);
  }
}

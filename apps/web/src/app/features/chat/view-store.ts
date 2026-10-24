import { DOCUMENT } from '@angular/common';
import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
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

  /** The provider saved in Settings; undefined until they load. */
  private readonly savedProvider = computed(
    () => this.settings.settings()?.ai.provider,
  );

  /**
   * True while today's spend is loading or unreadable (the API answers for itself then);
   * false at once when Settings save "Nenhum" (KBC-007 FR-5).
   */
  readonly researchAvailable = computed(
    () => this.spend.configured() && this.savedProvider() !== 'none',
  );
  readonly current = computed<ChatView>(() =>
    this.researchAvailable() ? (this.chosen() ?? this.preferred()) : 'search',
  );

  constructor() {
    // Another provider saved: ask the API again whether research can run now.
    let previous: string | null | undefined;
    effect(() => {
      const provider = this.savedProvider();
      untracked(() => {
        if (previous !== undefined && provider !== previous)
          this.spend.refresh();
        previous = provider;
      });
    });
  }

  select(view: ChatView): void {
    if (view === 'research' && !this.researchAvailable()) return;
    this.chosen.set(view);
    writeViewPreference(this.storage, view);
  }
}

import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type {
  AiTestRequest,
  AiTestResult,
  SettingsUpdate,
  SettingsView,
} from '@kb-chat/contracts';
import { SettingsApi } from '@core/api/settings-api.js';
import { ThemeStore } from '@core/theme/theme-store.js';
import { writeModePreference } from '@features/chat/mode-preference.js';
import { writeViewPreference } from '@features/chat/view-preference.js';
import { tap, type Observable } from 'rxjs';

export type SettingsPanel = 'settings' | 'onboarding';

/** This browser's own choices (ThemeStore, mode-preference). */
const THEME_KEY = 'kb-chat.theme';
const MODE_KEY = 'kb-chat.search-mode';

/** localStorage access itself can throw (blocked site data); the app then runs without it. */
function safeStorage(view: Window | null): Storage | undefined {
  try {
    return view?.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Settings, AI providers and which settings screen is open (KBC-007). Nothing is fetched
 * until the shell starts it, so pages that only show the ⚙ button stay quiet in tests.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly api = inject(SettingsApi);
  private readonly themes = inject(ThemeStore);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);
  private readonly started = signal(false);
  private readonly requested = signal<SettingsPanel | null>(null);
  private readonly onboardingDismissed = signal(false);

  readonly view = rxResource({
    params: () => this.started() || undefined,
    stream: () =>
      this.api.settings().pipe(tap((view) => this.applyUnchosen(view))),
  });
  readonly providers = rxResource({
    params: () => this.started() || undefined,
    stream: () => this.api.providers(),
  });

  readonly settings = computed(() =>
    this.view.hasValue() ? this.view.value() : null,
  );
  readonly providerList = computed(() =>
    this.providers.hasValue() ? this.providers.value() : null,
  );
  /** No settings saved yet: the first-run wizard shows (BR-5). */
  readonly firstRun = computed(() => this.settings()?.exists === false);
  /** The open screen; the wizard opens by itself on the first run, once per page. */
  readonly panel = computed<SettingsPanel | null>(
    () =>
      this.requested() ??
      (this.firstRun() && !this.onboardingDismissed() ? 'onboarding' : null),
  );

  start(): void {
    this.started.set(true);
  }

  openSettings(): void {
    this.start();
    this.requested.set('settings');
  }

  openOnboarding(): void {
    this.start();
    this.requested.set('onboarding');
  }

  close(): void {
    this.requested.set(null);
    this.onboardingDismissed.set(true);
  }

  save(update: SettingsUpdate): Observable<SettingsView> {
    return this.api.save(update).pipe(
      tap((view) => {
        this.view.set(view);
        this.applyLocal(view);
        this.providers.reload();
      }),
    );
  }

  test(request: AiTestRequest): Observable<AiTestResult> {
    return this.api.test(request);
  }

  /**
   * On load, saved preferences fill only what this browser never chose: a theme or search
   * mode picked in the side panel or the question box stays (KBC-005 BR-3).
   */
  private applyUnchosen(view: SettingsView): void {
    if (!view.exists) return;
    if (this.readStored(THEME_KEY) === null)
      this.themes.set(view.preferences.theme);
    if (this.readStored(MODE_KEY) === null)
      writeModePreference(this.storage, view.preferences.searchMode);
  }

  private readStored(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  /** Saving from Settings or the wizard sets this browser's choices too (the view on the next page). */
  private applyLocal(view: SettingsView): void {
    if (!view.exists) return;
    this.themes.set(view.preferences.theme);
    writeModePreference(this.storage, view.preferences.searchMode);
    writeViewPreference(this.storage, view.preferences.defaultView);
  }
}

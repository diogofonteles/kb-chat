import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type {
  AiTestRequest,
  AiTestResult,
  ResearchProfile,
  SettingsUpdate,
  SettingsView,
} from '@kb-chat/contracts';
import { SettingsApi } from '@core/api/settings-api.js';
import { HouseAiApi } from '@core/api/house-ai-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { ThemeStore } from '@core/theme/theme-store.js';
import { writeModePreference } from '@features/chat/mode-preference.js';
import { writeViewPreference } from '@features/chat/view-preference.js';
import {
  readProfilePreference,
  writeProfilePreference,
} from '@features/research/profile-preference.js';
import { tap, type Observable } from 'rxjs';

export type SettingsPanel = 'settings' | 'onboarding';

/** The sections of Configurações; `people` is "Pessoas e permissões" (masters, KBC-010). */
export type SettingsSection =
  'ai' | 'house' | 'preferences' | 'people' | 'about';

/** How an OpenRouter round trip ended (`?openrouter=` on the way back, KBC-022). */
export type ConnectOutcome = 'connected' | 'error';

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
  private readonly houseApi = inject(HouseAiApi);
  private readonly themes = inject(ThemeStore);
  private readonly session = inject(SessionStore);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);
  private readonly started = signal(false);
  private readonly requested = signal<SettingsPanel | null>(null);
  private readonly onboardingDismissed = signal(false);
  private readonly requestedSection = signal<SettingsSection | null>(null);
  /** The section Configurações opens at (the sidebar's "Pessoas e permissões"). */
  readonly section = this.requestedSection.asReadonly();
  private readonly returned = signal<ConnectOutcome | null>(null);
  /** The outcome of the last OpenRouter round trip, shown once where it was started. */
  readonly connectOutcome = this.returned.asReadonly();
  /** Choosing a provider or a key is a feature of its own (KBC-010). */
  readonly ownAi = computed(() => this.session.can('own-ai-settings'));
  /** The profile this browser picked in the research composer (KBC-011). */
  private readonly chosenProfile = signal<ResearchProfile | null>(
    readProfilePreference(this.storage),
  );

  readonly view = rxResource({
    params: () => this.started() || undefined,
    stream: () =>
      this.api.settings().pipe(tap((view) => this.applyUnchosen(view))),
  });
  readonly providers = rxResource({
    params: () => (this.started() && this.ownAi()) || undefined,
    stream: () => this.api.providers(),
  });

  /** Which AI serves the person now and who pays (KBC-022). */
  readonly aiStatus = rxResource({
    params: () => this.started() || undefined,
    stream: () => this.houseApi.status(),
  });

  readonly settings = computed(() =>
    this.view.hasValue() ? this.view.value() : null,
  );
  readonly providerList = computed(() =>
    this.providers.hasValue() ? this.providers.value() : null,
  );
  /** The research profile: this browser's choice, else the Settings default, else fast. */
  readonly researchProfile = computed<ResearchProfile>(
    () =>
      this.chosenProfile() ??
      this.settings()?.preferences.researchProfile ??
      'fast',
  );
  /** No settings saved yet: the first-run wizard shows (BR-5). */
  readonly firstRun = computed(
    () => this.settings()?.exists === false && this.ownAi(),
  );
  /** The open screen; the wizard opens by itself on the first run, once per page. */
  readonly panel = computed<SettingsPanel | null>(
    () =>
      this.requested() ??
      (this.firstRun() && !this.onboardingDismissed() ? 'onboarding' : null),
  );

  start(): void {
    this.started.set(true);
  }

  openSettings(section: SettingsSection | null = null): void {
    this.start();
    this.requestedSection.set(section);
    this.requested.set('settings');
  }

  openOnboarding(): void {
    this.start();
    this.requested.set('onboarding');
  }

  /**
   * Back from OpenRouter (`?openrouter=connected|error&for=house`): Configurações opens where
   * the connection started, with the outcome (KBC-022).
   */
  returnFromOpenRouter(search: string): boolean {
    const params = new URLSearchParams(search);
    const outcome = params.get('openrouter');
    if (outcome !== 'connected' && outcome !== 'error') return false;
    this.returned.set(outcome);
    this.openSettings(params.get('for') === 'house' ? 'house' : 'ai');
    return true;
  }

  close(): void {
    this.requested.set(null);
    this.onboardingDismissed.set(true);
  }

  save(update: SettingsUpdate): Observable<SettingsView> {
    const savedProfile = this.settings()?.preferences.researchProfile;
    return this.api.save(update).pipe(
      tap((view) => {
        this.view.set(view);
        this.applyLocal(view);
        // A changed default in Settings also becomes this browser's choice; other saves keep it.
        const profile = update.preferences?.researchProfile;
        if (profile && profile !== savedProfile)
          this.chooseResearchProfile(profile);
        this.providers.reload();
        this.aiStatus.reload();
      }),
    );
  }

  /** The composer's "Rápido | Profundo": remembered in this browser. */
  chooseResearchProfile(profile: ResearchProfile): void {
    this.chosenProfile.set(profile);
    writeProfilePreference(this.storage, profile);
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

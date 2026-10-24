import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Preferences } from '@kb-chat/contracts';
import { AiProviderForm } from './ai-provider-form.js';
import {
  aiDraftFrom,
  aiUpdateFrom,
  modelErrors,
  type AiDraft,
} from './ai-draft.js';
import { PreferencesForm } from './preferences-form.js';
import { SettingsStore } from './settings-store.js';

export type SettingsSection = 'ai' | 'preferences' | 'about';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

/** "Configurações" (KBC-007 FR-6): AI provider, preferences and where the data lives. */
@Component({
  selector: 'app-settings-panel',
  imports: [AiProviderForm, PreferencesForm],
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPanel {
  private readonly store = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly closed = output();

  protected readonly section = signal<SettingsSection>('ai');
  protected readonly sections: readonly {
    id: SettingsSection;
    label: string;
  }[] = [
    { id: 'ai', label: $localize`:@@settings.ai:IA` },
    {
      id: 'preferences',
      label: $localize`:@@settings.preferences:Preferências`,
    },
    { id: 'about', label: $localize`:@@settings.about:Sobre` },
  ];
  protected readonly settings = this.store.settings;
  protected readonly loadFailed = computed(
    () => this.store.view.error() !== undefined,
  );
  protected readonly aiDraft = linkedSignal<AiDraft | null>(() => {
    const view = this.store.settings();
    return view ? aiDraftFrom(view, this.store.providerList()) : null;
  });
  protected readonly preferences = linkedSignal<Preferences | null>(
    () => this.store.settings()?.preferences ?? null,
  );
  protected readonly aiSave = signal<SaveState>('idle');
  protected readonly preferencesSave = signal<SaveState>('idle');

  protected show(section: SettingsSection): void {
    this.section.set(section);
  }

  protected editAi(draft: AiDraft): void {
    this.aiDraft.set(draft);
    this.aiSave.set('idle');
  }

  protected saveAi(): void {
    const draft = this.aiDraft();
    if (!draft) return;
    // A model the API would refuse is shown on its field, not as a failed save.
    if (Object.keys(modelErrors(draft)).length > 0) {
      this.aiSave.set('invalid');
      return;
    }
    this.aiSave.set('saving');
    this.store
      .save({ ai: aiUpdateFrom(draft) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.aiSave.set('saved'),
        error: () => this.aiSave.set('failed'),
      });
  }

  /** Preferences apply as soon as they change, like a system settings screen. */
  protected savePreferences(preferences: Preferences): void {
    this.preferences.set(preferences);
    this.preferencesSave.set('saving');
    this.store
      .save({
        preferences: {
          ...preferences,
          defaultTopic: preferences.defaultTopic ?? null,
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.preferencesSave.set('saved'),
        error: () => this.preferencesSave.set('failed'),
      });
  }

  protected reopenWizard(): void {
    this.store.openOnboarding();
  }

  protected retry(): void {
    this.store.view.reload();
    this.store.providers.reload();
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  linkedSignal,
  output,
  signal,
  viewChild,
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
import { SessionStore } from '@core/auth/session-store.js';
import { PeoplePanel } from '@features/people/people-panel.js';
import { HouseAiPanel } from '@features/house-ai/house-ai-panel.js';
import { TermsPanel } from '@features/transcribers/terms-panel.js';
import { LearningPanel } from '@features/transcribers/learning-panel.js';
import { GroqPanel } from '@features/transcribers/groq-panel.js';
import { ExistingTracks } from '@features/transcribers/existing-tracks.js';
import { TranscribersPanel } from '@features/transcribers/transcribers-panel.js';
import { VoiceProfilesPanel } from '@features/voice-profiles/voice-profiles-panel.js';
import { AiStatusCard } from './ai-status-card.js';
import { PreferencesForm } from './preferences-form.js';
import { ActAsAudit } from '@features/acting/act-as-audit.js';
import { MyAccesses } from '@features/acting/my-accesses.js';
import { SettingsStore, type SettingsSection } from './settings-store.js';

export type { SettingsSection } from './settings-store.js';

const SECTIONS: readonly { id: SettingsSection; label: () => string }[] = [
  { id: 'ai', label: () => $localize`:@@settings.ai:Sua IA` },
  {
    id: 'house',
    label: () => $localize`:@@settings.house:IA da aplicação`,
  },
  {
    id: 'preferences',
    label: () => $localize`:@@settings.preferences:Preferências`,
  },
  {
    id: 'people',
    label: () => $localize`:@@settings.people:Pessoas e permissões`,
  },
  {
    id: 'transcribers',
    label: () => $localize`:@@settings.transcribers:Transcritores`,
  },
  {
    id: 'terms',
    label: () => $localize`:@@settings.terms:Termos da transcrição`,
  },
  {
    id: 'groq',
    label: () => $localize`:@@settings.groq:Groq de reserva`,
  },
  {
    id: 'voice-profiles',
    label: () => $localize`:@@settings.voiceProfiles:Perfis de voz`,
  },
  {
    id: 'audit',
    label: () => $localize`:@@settings.audit:Auditoria do Ver como`,
  },
  {
    id: 'accesses',
    label: () => $localize`:@@settings.accesses:Acessos à sua conta`,
  },
  { id: 'about', label: () => $localize`:@@settings.about:Sobre` },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

/** "Configurações" (KBC-007 FR-6): AI provider, preferences and where the data lives. */
@Component({
  selector: 'app-settings-panel',
  imports: [
    AiProviderForm,
    PreferencesForm,
    PeoplePanel,
    HouseAiPanel,
    TranscribersPanel,
    ExistingTracks,
    TermsPanel,
    LearningPanel,
    GroqPanel,
    VoiceProfilesPanel,
    AiStatusCard,
    ActAsAudit,
    MyAccesses,
  ],
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPanel {
  private readonly store = inject(SettingsStore);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly closed = output();
  private readonly aiForm = viewChild(AiProviderForm);

  /** Only what the person may change (KBC-010): AI with own-ai-settings, people for masters. */
  protected readonly sections = computed(() =>
    SECTIONS.filter(
      ({ id }) =>
        (id !== 'ai' || this.store.ownAi()) &&
        (id !== 'people' || this.session.isMaster()) &&
        (id !== 'house' || this.session.isMaster()) &&
        // KBC-036 BR-1: masters pair the Macs, only where the media library is on.
        // KBC-037: so does connecting Groq, the transcription's fallback.
        ((id !== 'transcribers' && id !== 'terms' && id !== 'groq') ||
          (this.session.isMaster() && this.session.me()?.media === true)) &&
        // KBC-071 (ADR 0032): a master's, where the media library is on.
        (id !== 'voice-profiles' ||
          (this.session.me()?.features.includes('media-voice-profiles') ===
            true &&
            this.session.me()?.media === true)) &&
        (id !== 'audit' || this.session.me()?.canActAs === true),
    ).map(({ id, label }) => ({ id, label: label() })),
  );
  protected readonly section = linkedSignal<SettingsSection>(() => {
    const available = this.sections().map(({ id }) => id);
    const requested = this.store.section();
    return requested && available.includes(requested)
      ? requested
      : (available[0] ?? 'about');
  });
  protected readonly settings = this.store.settings;
  protected readonly connectOutcome = this.store.connectOutcome;
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

  /** "Configurar a minha IA" (KBC-024): to the options, where one's own AI is chosen. */
  protected focusOptions(): void {
    this.aiForm()?.focusOwnOptions();
  }

  /** Without the AI section, "Quem atende você" shows in Preferências (KBC-024 BR-6). */
  protected readonly ownAi = this.store.ownAi;

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

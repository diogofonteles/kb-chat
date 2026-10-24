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
import type { Preferences, SettingsUpdate } from '@kb-chat/contracts';
import { AiProviderForm } from './ai-provider-form.js';
import { aiDraftFrom, aiUpdateFrom, type AiDraft } from './ai-draft.js';
import { PreferencesForm, type PreferenceField } from './preferences-form.js';
import { SettingsStore } from './settings-store.js';

interface Step {
  readonly title: string;
  readonly lead: string;
  /** null: the AI step; otherwise the preference fields of the step. */
  readonly fields: readonly PreferenceField[] | null;
}

const AI_STEP: Step = {
  title: $localize`:@@wizard.aiTitle:Como a IA vai responder?`,
  lead: $localize`:@@wizard.aiLead:Com a sua assinatura do Claude ou do ChatGPT não há cobrança por uso. Dá para mudar depois em Configurações.`,
  fields: null,
};

const STEPS: readonly Step[] = [
  AI_STEP,
  {
    title: $localize`:@@wizard.viewTitle:Por onde começar?`,
    lead: $localize`:@@wizard.viewLead:A tela que abre primeiro e o jeito de buscar.`,
    fields: ['view', 'mode'],
  },
  {
    title: $localize`:@@wizard.topicTitle:Qual acervo você estuda?`,
    lead: $localize`:@@wizard.topicLead:O acervo que abre por padrão.`,
    fields: ['topic'],
  },
  {
    title: $localize`:@@wizard.themeTitle:Escolha o tema`,
    lead: $localize`:@@wizard.themeLead:Claro, escuro ou o esotérico.`,
    fields: ['theme'],
  },
];

/** First-run wizard (KBC-007 FR-1, BR-5): four short steps, each skippable. */
@Component({
  selector: 'app-onboarding',
  imports: [AiProviderForm, PreferencesForm],
  templateUrl: './onboarding.html',
  styleUrl: './onboarding.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Onboarding {
  private readonly store = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly finished = output();

  protected readonly steps = STEPS;
  protected readonly index = signal(0);
  protected readonly step = computed(() => STEPS[this.index()] ?? AI_STEP);
  protected readonly stepNumber = computed(() => this.index() + 1);
  protected readonly last = computed(() => this.index() === STEPS.length - 1);
  protected readonly saving = signal(false);
  protected readonly failed = signal(false);
  protected readonly aiDraft = linkedSignal<AiDraft | null>(() => {
    const view = this.store.settings();
    return view ? aiDraftFrom(view, this.store.providerList()) : null;
  });
  protected readonly preferences = linkedSignal<Preferences | null>(
    () => this.store.settings()?.preferences ?? null,
  );

  protected next(): void {
    this.index.update((i) => Math.min(i + 1, STEPS.length - 1));
  }

  protected back(): void {
    this.index.update((i) => Math.max(i - 1, 0));
  }

  /** "Pular" keeps every default and still records that the first run happened (FR-1). */
  protected skip(): void {
    this.submit({});
  }

  protected finish(): void {
    const draft = this.aiDraft();
    const preferences = this.preferences();
    this.submit({
      ...(draft ? { ai: aiUpdateFrom(draft) } : {}),
      ...(preferences
        ? {
            preferences: {
              ...preferences,
              defaultTopic: preferences.defaultTopic ?? null,
            },
          }
        : {}),
    });
  }

  private submit(update: SettingsUpdate): void {
    this.saving.set(true);
    this.failed.set(false);
    this.store
      .save(update)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.finished.emit(),
        error: () => {
          this.saving.set(false);
          this.failed.set(true);
        },
      });
  }
}

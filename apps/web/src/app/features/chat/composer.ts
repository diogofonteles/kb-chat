import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  RESEARCH_PROFILES,
  researchProfileSchema,
  searchModeSchema,
  type ResearchProfile,
  type SearchMode,
} from '@kb-chat/contracts';
import { BusyWork, DRAFT_KEPT_ATTRIBUTE } from '@core/app-version/busy-work.js';
import {
  DRAFT_OWNER,
  keepDraft,
  takeKeptDraft,
} from '@core/app-version/kept-draft.js';
import { MODE_OPTIONS } from '@core/i18n/facet-labels.js';
import { PROFILE_COPY } from '@features/research/profile-copy.js';

/** Where the question box keeps its draft across a reload into a new version. */
export const COMPOSER_DRAFT_KEY = 'kb-chat.composer-draft';

/**
 * Question box: multiline text, "Como buscar" mode and send (screens.md T1). Shared by both
 * views; in "Pesquisa com IA" there is no search mode, the question may be longer and a
 * "Rápido | Profundo" toggle picks the research profile (KBC-011).
 */
@Component({
  selector: 'app-composer',
  templateUrl: './composer.html',
  styleUrl: './composer.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Composer {
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly draftOwner = inject(DRAFT_OWNER);

  readonly disabled = input(false);
  readonly research = input(false);
  readonly mode = model.required<SearchMode>();
  readonly profile = model<ResearchProfile>('fast');
  readonly submitted = output<string>();

  private readonly field =
    viewChild.required<ElementRef<HTMLTextAreaElement>>('field');
  /** Same limits as the API contracts (searchRequestSchema, researchRequestSchema). */
  protected readonly maxLength = computed(() => (this.research() ? 2000 : 500));
  /** A question typed before the app reloaded into a new version comes back (KBC-123). */
  protected readonly text = signal(
    takeKeptDraft(this.view, COMPOSER_DRAFT_KEY, this.draftOwner()),
  );
  /** The question box keeps its own draft: the app-wide edit rule leaves it out. */
  protected readonly draftKept = DRAFT_KEPT_ATTRIBUTE;
  protected readonly nearLimit = computed(
    () => this.text().length >= this.maxLength() - 50,
  );
  protected readonly modes = MODE_OPTIONS;
  protected readonly profiles = RESEARCH_PROFILES.map((value) => ({
    value,
    label: PROFILE_COPY[value].label(),
  }));
  protected readonly profileHelp = computed(() =>
    PROFILE_COPY[this.profile()].help(),
  );
  protected readonly canSend = computed(
    () => !this.disabled() && this.text().trim().length > 0,
  );
  protected readonly sendHint = computed(() =>
    this.disabled()
      ? $localize`:@@composer.sendHintNoTopic:Nenhum acervo disponível para buscar.`
      : $localize`:@@composer.sendHint:Escreva uma pergunta para buscar.`,
  );
  protected readonly placeholder = computed(() =>
    this.research()
      ? $localize`:@@composer.placeholderResearch:Pergunte qualquer coisa sobre o acervo…`
      : $localize`:@@composer.placeholder:ex.: o que é a natureza sétupla?`,
  );
  protected readonly modeHelp = computed(
    () => MODE_OPTIONS.find((o) => o.value === this.mode())?.help ?? '',
  );

  constructor() {
    // A question typed and not sent holds a reload into a new version (KBC-123 AC-2); when
    // the person reloads anyway ("Atualizar"), it is written down and comes back.
    const work = inject(BusyWork);
    work.holdWhile(computed(() => this.text().trim().length > 0));
    work.keepBeforeReload(() =>
      keepDraft(this.view, COMPOSER_DRAFT_KEY, {
        owner: this.draftOwner(),
        text: this.text(),
      }),
    );
  }

  /** True for the question field while it is still empty (the "/" hint's target). */
  isEmptyField(target: EventTarget | null): boolean {
    const field = this.field().nativeElement;
    return target === field && field.value === '';
  }

  focus(): void {
    this.field().nativeElement.focus();
  }

  protected updateText(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  protected selectMode(event: Event): void {
    const parsed = searchModeSchema.safeParse(
      (event.target as HTMLSelectElement).value,
    );
    if (parsed.success) this.mode.set(parsed.data);
  }

  protected selectProfile(value: string): void {
    const parsed = researchProfileSchema.safeParse(value);
    if (parsed.success) this.profile.set(parsed.data);
  }

  protected sendOnEnter(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    this.send();
  }

  protected send(): void {
    if (!this.canSend()) return;
    this.submitted.emit(this.text().trim());
    this.clear();
  }

  protected clear(): void {
    this.text.set('');
    this.focus();
  }
}

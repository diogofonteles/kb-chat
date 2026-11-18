import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  model,
  output,
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
import { UiIcon } from '@ui/icon.js';

/** Where the question box keeps its draft across a reload into a new version. */
export const COMPOSER_DRAFT_KEY = 'kb-chat.composer-draft';

/**
 * Question box: multiline text, "Como buscar" mode and send (screens.md T1). Shared by both
 * views; in "Pesquisa com IA" there is no search mode, the question may be longer and a
 * "Rápido | Profundo" toggle picks the research profile (KBC-011). v2 (KBC-126 FR-4): a
 * rounded box fixed at the panel's foot, the modes and profiles as chips with their help.
 */
@Component({
  selector: 'app-composer',
  imports: [UiIcon],
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
  /** A phone: the box is the floating pill of v2 · Conversa (celular), cmComposer. */
  readonly compact = input(false);
  /** A phone's search page: the box is the search pill under "Buscar" (cmResults). */
  readonly searchPill = input(false);
  /** A phone's research home draws the profiles at the top: the box leaves its own out. */
  readonly profilesAbove = input(false);
  protected readonly maxLength = computed(() => (this.research() ? 2000 : 500));
  /** A question typed before the app reloaded into a new version comes back (KBC-123). */
  /**
   * A question the page shows in the box: the phone's search pill holds the search on screen
   * (cmResults). Back to null (a new conversation), the box empties.
   */
  readonly value = input<string | null>(null);
  protected readonly text = linkedSignal<string | null, string>({
    source: this.value,
    computation: (value, previous) => {
      if (value !== null) return value;
      return previous
        ? ''
        : takeKeptDraft(this.view, COMPOSER_DRAFT_KEY, this.draftOwner());
    },
  });
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
  protected readonly placeholder = computed(() => {
    if (this.research())
      return $localize`:@@composer.placeholderResearch:Pergunte qualquer coisa sobre o acervo…`;
    return this.compact()
      ? $localize`:@@composer.placeholderPhone:Pergunte em linguagem natural…`
      : $localize`:@@composer.placeholder:ex.: o que é a natureza sétupla?`;
  });
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

  /** A question started elsewhere ("Perguntar à IA" on a document), the caret at its end. */
  fill(text: string): void {
    this.text.set(text);
    const field = this.field().nativeElement;
    field.value = text;
    field.focus();
    field.setSelectionRange(text.length, text.length);
  }

  protected updateText(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  protected selectMode(event: Event): void {
    const parsed = searchModeSchema.safeParse(
      (event.target as HTMLInputElement).value,
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
    // The phone's search pill keeps what it searched for, as a search field does (cmResults).
    if (!this.searchPill()) this.clear();
  }

  protected clear(): void {
    this.text.set('');
    this.focus();
  }
}

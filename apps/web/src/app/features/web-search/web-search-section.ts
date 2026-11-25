import { NgTemplateOutlet, formatNumber } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  WEB_SEARCH_AUTHORS,
  WEB_SEARCH_KINDS,
  WEB_SEARCH_QUERY,
  WEB_SEARCH_SOURCES,
  webSearchAvailabilitySchema,
  type UploadedDocumentRef,
  type WebSearchKind,
  type WebSearchResult,
} from '@kb-chat/contracts';
import { errorMessage, type UiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { webSearchAvailableUrl } from '@core/web-search/web-search-api.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  UiBanner,
  UiButton,
  UiChip,
  UiIcon,
  UiPill,
  UiProgress,
  fieldDescribedBy,
  type IconName,
} from '@ui/index.js';
import { WebSearchForm, type AuthorProblem } from './web-search-form.js';
import {
  AUTHOR_PROBLEMS,
  KIND_LABELS,
  countLabel,
  creditsEstimate,
  creditsLabel,
  moreLabel,
  progressLabel,
  skippedLabel,
} from './web-search-labels.js';
import { WebSearchRun, type SearchAsked } from './web-search-run.js';

/** What stopped the search; one at a time (PD-05: a union, never flags). */
type Problem =
  | { readonly kind: 'off' | 'no-credits' | 'limited' }
  | { readonly kind: 'failed'; readonly message: string };

interface Row extends WebSearchResult {
  readonly id: string;
  /** Sent from here a moment ago. */
  readonly taken: boolean;
  readonly kindLabel: string;
}

const KIND_ICONS: Record<WebSearchKind, IconName> = {
  text: 'file',
  audio: 'music',
  video: 'play',
};

/**
 * "Pesquisar na web" (KBC-185): texts, audios and videos found on the web, to pick from. They
 * come picked, but what the collection already has; nothing is added here: what is picked
 * (`WebSearchRun`) the page includes as it includes files and links.
 */
@Component({
  selector: 'app-web-search-section',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    UiBanner,
    UiButton,
    UiChip,
    UiIcon,
    UiPill,
    UiProgress,
  ],
  templateUrl: './web-search-section.html',
  styleUrl: './web-search-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebSearchSection {
  private readonly run = inject(WebSearchRun);
  private readonly chat = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);
  protected readonly form = inject(WebSearchForm);
  protected readonly isMaster = inject(SessionStore).isMaster;

  /** The collection the search is for (its slug). */
  readonly topic = input.required<string>();
  /** The parent is busy sending, or may not send now. */
  readonly disabled = input(false);

  private readonly subjectInput =
    viewChild<ElementRef<HTMLInputElement>>('subjectInput');
  private readonly sourcesInput =
    viewChild<ElementRef<HTMLInputElement>>('sourcesInput');
  private readonly authorInput =
    viewChild<ElementRef<HTMLInputElement>>('authorInput');
  private readonly searchButton =
    viewChild<ElementRef<HTMLButtonElement>>('searchButton');

  protected readonly chips = WEB_SEARCH_KINDS.map((kind) => ({
    kind,
    icon: KIND_ICONS[kind],
    label: KIND_LABELS[kind](),
  }));
  protected readonly subjectLimits = WEB_SEARCH_QUERY;
  protected readonly sourcesMin = WEB_SEARCH_SOURCES.min;
  protected readonly authorLimits = WEB_SEARCH_AUTHORS;
  protected readonly settingsLink = '/configuracoes/pesquisa-na-web';
  protected readonly skeletons = [0, 1, 2, 3];

  private readonly available = httpResource(() => webSearchAvailableUrl(), {
    parse: (body) => webSearchAvailabilitySchema.parse(body),
  });
  /** A search was tried with something missing: say what, until it is there. */
  private readonly tried = signal(false);
  /** With no key there is nothing to fill in. */
  protected readonly unavailable = computed(
    () => this.available.hasValue() && !this.available.value().connected,
  );
  /** This collection's search; another one's is not shown here. */
  protected readonly search = computed(() => this.run.of(this.topic()));
  protected readonly searching = computed(
    () => this.search()?.searching === true,
  );
  protected readonly problem = computed<Problem | null>(() => {
    const error = this.search()?.error ?? null;
    return error && problemOf(error);
  });
  protected readonly problemKind = computed(() => this.problem()?.kind ?? null);
  protected readonly failure = computed(() => {
    const problem = this.problem();
    return problem?.kind === 'failed' ? problem.message : '';
  });
  protected readonly partial = computed(
    () => this.search()?.partial === true && !this.searching(),
  );
  protected readonly askedSubject = computed(
    () => this.search()?.asked.request.query ?? '',
  );
  protected readonly low = computed(
    () =>
      this.search()?.low === true ||
      (this.available.hasValue() && this.available.value().low),
  );
  /** Masters know the balance: what this would take of it. */
  protected readonly estimate = computed(() =>
    this.isMaster() && this.form.kinds().length > 0
      ? creditsEstimate(this.form.credits())
      : '',
  );
  /** What the search cost and left: masters only. */
  protected readonly credits = computed(() => {
    const search = this.search();
    if (!search || !this.isMaster() || search.creditsUsed === 0) return '';
    const { creditsUsed, creditsRemaining } = search;
    const left =
      creditsRemaining === null
        ? null
        : formatNumber(creditsRemaining, this.locale, '1.0-0');
    return creditsLabel(creditsUsed, left);
  });

  protected readonly rows = computed<readonly Row[]>(() => {
    const search = this.search();
    if (!search) return [];
    return search.results.map((result, at) => ({
      ...result,
      id: `web-result-${at}`,
      kindLabel: KIND_LABELS[result.kind](),
      taken: search.taken.has(result.url),
    }));
  });
  protected readonly selectable = computed(() =>
    this.rows().filter((row) => row.already === null && !row.taken),
  );
  protected readonly selected = computed<ReadonlySet<string>>(
    () => new Set(this.run.picksOf(this.topic()).map(({ url }) => url)),
  );
  protected readonly allSelected = computed(
    () =>
      this.selected().size > 0 &&
      this.selected().size === this.selectable().length,
  );
  protected readonly someSelected = computed(
    () => this.selected().size > 0 && !this.allSelected(),
  );
  protected readonly loading = computed(
    () => this.searching() && this.rows().length === 0,
  );
  protected readonly share = computed(() => {
    const search = this.search();
    return search ? Math.min(1, search.results.length / search.wanted) : 0;
  });
  /** The search ended: it can go on, or there is nothing else. */
  protected readonly ended = computed(
    () => this.search() !== null && !this.searching(),
  );
  protected readonly exhausted = computed(
    () => this.ended() && this.search()?.exhausted === true,
  );
  protected readonly canGoOn = computed(
    () => this.ended() && !this.exhausted() && this.problem() === null,
  );
  protected readonly moreText = computed(() =>
    moreLabel(this.form.sources() ?? WEB_SEARCH_SOURCES.default),
  );
  protected readonly skipped = computed(() => {
    const search = this.search();
    return search ? skippedLabel(search.skipped) : '';
  });
  /** Said to a screen reader too, when it changes (aria-live). */
  protected readonly status = computed(() => {
    const search = this.search();
    if (!search) return '';
    const found = search.results.length;
    if (search.searching) return progressLabel(found, search.wanted);
    if (search.error && found === 0) return '';
    const text =
      found > 0
        ? countLabel(found)
        : $localize`:@@webSearch.none:Nada encontrado para “${search.asked.request.query}:subject:”`;
    return [`${text}.`, this.credits()].filter(Boolean).join(' ');
  });

  protected readonly subjectProblem = computed(() =>
    this.tried() && !this.form.subjectValid()
      ? $localize`:@@webSearch.subjectShort:Escreva pelo menos 3 letras.`
      : '',
  );
  protected readonly sourcesProblem = computed(() =>
    this.form.sources() === null
      ? $localize`:@@webSearch.sourcesNumber:Use um número inteiro, a partir de 1.`
      : '',
  );
  protected readonly kindsProblem = computed(() =>
    this.form.kinds().length === 0
      ? $localize`:@@webSearch.kindsNone:Escolha pelo menos um tipo.`
      : '',
  );
  protected readonly typedAuthor = signal('');
  private readonly refusedAuthor = signal<AuthorProblem | null>(null);
  protected readonly authorProblem = computed(() => {
    const problem = this.refusedAuthor();
    return problem ? AUTHOR_PROBLEMS[problem]() : '';
  });
  protected readonly authorChips = computed(() =>
    this.form.authors().map((name) => ({
      name,
      remove: $localize`:@@webSearch.removeAuthor:Remover ${name}:author:`,
    })),
  );
  protected readonly subjectDescribedBy = computed(() =>
    fieldDescribedBy('web-search-subject', {
      error: this.subjectProblem(),
      hint: 'yes',
    }),
  );
  protected readonly sourcesDescribedBy = computed(() =>
    fieldDescribedBy('web-search-sources', {
      error: this.sourcesProblem(),
      hint: 'yes',
    }),
  );
  protected readonly authorDescribedBy = computed(() =>
    fieldDescribedBy('web-search-author', {
      error: this.authorProblem(),
      hint: 'yes',
    }),
  );

  protected editAuthor(event: Event): void {
    this.typedAuthor.set((event.target as HTMLInputElement).value);
    this.refusedAuthor.set(null);
  }

  /** Enter adds the name; it never sends the form. */
  protected authorEntered(event: Event): void {
    event.preventDefault();
    if ((event as KeyboardEvent).isComposing) return;
    this.addAuthor();
  }

  protected addAuthor(): void {
    if (this.disabled()) return;
    const problem = this.form.addAuthors(this.typedAuthor());
    this.refusedAuthor.set(problem);
    if (problem === null) this.typedAuthor.set('');
    this.authorInput()?.nativeElement.focus();
  }

  /** The chip goes away: the focus goes to the field (WCAG 2.4.3). */
  protected removeAuthor(name: string): void {
    this.form.removeAuthor(name);
    this.refusedAuthor.set(null);
    this.authorInput()?.nativeElement.focus();
  }

  /** One search at a time: a second press while one runs does nothing (it is paid, PD-02). */
  protected searchNow(event: Event): void {
    event.preventDefault();
    if (this.disabled() || this.searching()) return;
    this.tried.set(true);
    const asked = this.asked();
    const sources = this.form.sources();
    if (!asked || sources === null) return this.focusProblem();
    this.tried.set(false);
    this.run.start(asked, sources);
  }

  /** The form as a search; null while something in it is missing. */
  private asked(): SearchAsked | null {
    // A name typed and not added yet is wanted too.
    if (this.typedAuthor().trim() !== '') {
      const problem = this.form.addAuthors(this.typedAuthor());
      this.refusedAuthor.set(problem);
      if (problem !== null) return null;
      this.typedAuthor.set('');
    }
    if (!this.form.subjectValid() || this.form.kinds().length === 0)
      return null;
    return {
      topic: this.topic(),
      request: {
        query: this.form.subject().trim(),
        kinds: [...this.form.kinds()],
        authors: [...this.form.authors()],
        again: this.form.again(),
      },
    };
  }

  /** To the first field with a problem (the kinds say theirs by themselves). */
  private focusProblem(): void {
    const field = this.subjectProblem()
      ? this.subjectInput()
      : this.sourcesProblem()
        ? this.sourcesInput()
        : this.refusedAuthor()
          ? this.authorInput()
          : undefined;
    field?.nativeElement.focus();
  }

  /** The same search again. The button pressed goes away: the focus stays in the form. */
  protected retry(): void {
    this.searchButton()?.nativeElement.focus();
    this.run.retry();
  }

  protected more(): void {
    this.run.more(this.form.sources() ?? WEB_SEARCH_SOURCES.default);
  }

  protected stop(): void {
    this.searchButton()?.nativeElement.focus();
    this.run.stop();
  }

  protected toggle(url: string): void {
    this.run.toggle(url);
  }

  protected toggleAll(): void {
    this.run.toggleAll();
  }

  /** The document the collection already has, in the conversation's reading panel. */
  protected openDocument(document: UploadedDocumentRef): void {
    this.chat.open(this.topic(), { id: document.id, title: document.title });
    void this.router.navigateByUrl('/');
  }
}

function problemOf(code: UiErrorCode): Problem {
  if (code === 'WEB_SEARCH_NOT_CONNECTED') return { kind: 'off' };
  if (code === 'WEB_SEARCH_NO_CREDITS') return { kind: 'no-credits' };
  if (code === 'RATE_LIMITED') return { kind: 'limited' };
  return { kind: 'failed', message: errorMessage(code) };
}

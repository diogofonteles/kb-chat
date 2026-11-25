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
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  WEB_SEARCH_AUTHORS,
  WEB_SEARCH_KINDS,
  WEB_SEARCH_QUERY,
  WEB_SEARCH_SOURCES,
  webSearchAvailabilitySchema,
  type UploadedDocumentRef,
  type WebSearchKind,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  WebSearchApi,
  webSearchAvailableUrl,
} from '@core/web-search/web-search-api.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  UiBanner,
  UiButton,
  UiChip,
  UiIcon,
  UiPill,
  fieldDescribedBy,
  type IconName,
} from '@ui/index.js';
import { WebSearchForm, type AuthorProblem } from './web-search-form.js';
import {
  AUTHOR_PROBLEMS,
  KIND_LABELS,
  callsLabel,
  countLabel,
  creditsLabel,
  includeLabel,
} from './web-search-labels.js';

/** What the person picked: the parent sends it as links (KBC-149). */
export interface PickedWebResult {
  readonly url: string;
  readonly title: string;
  readonly kind: WebSearchKind;
}

/** A search as asked: kept to ask it again. */
interface Asked {
  readonly topic: string;
  readonly request: WebSearchRequest;
}

/** What is under the form; one at a time (PD-05: a union, never flags). */
type View =
  | { readonly kind: 'idle' | 'loading' | 'off' | 'no-credits' | 'limited' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'found'; readonly response: WebSearchResponse };

interface Row extends WebSearchResult {
  readonly id: string;
  readonly kindLabel: string;
}

const KIND_ICONS: Record<WebSearchKind, IconName> = {
  text: 'file',
  audio: 'music',
  video: 'play',
};

/**
 * "Pesquisar na web" (KBC-185): texts, audios and videos found on the web, to pick from. They
 * come picked, but what the collection already has; nothing is added here: what stays picked
 * goes out by `picked`.
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
  ],
  templateUrl: './web-search-section.html',
  styleUrl: './web-search-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebSearchSection {
  private readonly api = inject(WebSearchApi);
  private readonly chat = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);
  protected readonly form = inject(WebSearchForm);
  protected readonly isMaster = inject(SessionStore).isMaster;

  /** The collection the search is for (its slug). */
  readonly topic = input.required<string>();
  /** The parent is busy sending, or may not send now. */
  readonly disabled = input(false);
  readonly picked = output<PickedWebResult[]>();

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
  protected readonly sourcesLimits = WEB_SEARCH_SOURCES;
  protected readonly authorLimits = WEB_SEARCH_AUTHORS;
  protected readonly settingsLink = '/configuracoes/pesquisa-na-web';
  protected readonly skeletons = [0, 1, 2, 3];

  private readonly available = httpResource(() => webSearchAvailableUrl(), {
    parse: (body) => webSearchAvailabilitySchema.parse(body),
  });
  /** A search was tried with something missing: say what, until it is there. */
  private readonly tried = signal(false);
  /** Another collection starts over: what is "already there" is the collection's. */
  private readonly asked = linkedSignal<string, Asked | null>({
    source: this.topic,
    computation: () => null,
  });
  private readonly found = rxResource({
    params: () => this.asked() ?? undefined,
    stream: ({ params: { topic, request } }) => this.api.search(topic, request),
  });

  /** With no key there is nothing to fill in. */
  protected readonly unavailable = computed(
    () => this.available.hasValue() && !this.available.value().connected,
  );
  protected readonly loading = this.found.isLoading;
  protected readonly view = computed<View>(() => {
    if (this.loading()) return { kind: 'loading' };
    const error = this.found.error();
    if (error) return failedView(error);
    return this.found.hasValue()
      ? { kind: 'found', response: this.found.value() }
      : { kind: 'idle' };
  });
  private readonly response = computed(() => {
    const view = this.view();
    return view.kind === 'found' ? view.response : null;
  });
  protected readonly failure = computed(() => {
    const view = this.view();
    return view.kind === 'failed' ? view.message : '';
  });
  protected readonly partial = computed(
    () => this.response()?.partial === true,
  );
  protected readonly askedSubject = computed(
    () => this.asked()?.request.query ?? '',
  );
  protected readonly low = computed(
    () =>
      this.response()?.low ??
      (this.available.hasValue() && this.available.value().low),
  );
  protected readonly calls = computed(() => {
    const calls = this.form.calls();
    return calls > 0 ? callsLabel(calls) : '';
  });
  /** What the search cost and left: masters only. */
  protected readonly credits = computed(() => {
    const response = this.response();
    if (!response || !this.isMaster()) return '';
    const { creditsUsed, creditsRemaining } = response;
    const left =
      creditsRemaining === null
        ? null
        : formatNumber(creditsRemaining, this.locale, '1.0-0');
    return creditsLabel(creditsUsed, left);
  });

  protected readonly rows = computed<readonly Row[]>(() =>
    (this.response()?.results ?? []).map((result, at) => ({
      ...result,
      id: `web-result-${at}`,
      kindLabel: KIND_LABELS[result.kind](),
    })),
  );
  protected readonly selectable = computed(() =>
    this.rows().filter((row) => row.already === null),
  );
  /** Every candidate comes picked, but what the collection already has. */
  protected readonly selected = linkedSignal<
    readonly Row[],
    ReadonlySet<string>
  >({
    source: this.selectable,
    computation: (rows) => new Set(rows.map((row) => row.url)),
  });
  protected readonly allSelected = computed(
    () =>
      this.selected().size > 0 &&
      this.selected().size === this.selectable().length,
  );
  protected readonly someSelected = computed(
    () => this.selected().size > 0 && !this.allSelected(),
  );
  protected readonly includeLabel = computed(() =>
    includeLabel(this.selected().size),
  );
  protected readonly cannotInclude = computed(
    () => this.disabled() || this.selected().size === 0,
  );
  /** Said to a screen reader too, when it changes (aria-live). */
  protected readonly status = computed(() => {
    const view = this.view();
    if (view.kind === 'loading')
      return $localize`:@@webSearch.loading:Pesquisando na web…`;
    if (view.kind !== 'found') return '';
    const found =
      this.rows().length > 0
        ? countLabel(this.rows().length, this.selectable().length)
        : $localize`:@@webSearch.none:Nada encontrado para “${this.askedSubject()}:subject:”`;
    return [`${found}.`, this.credits()].filter(Boolean).join(' ');
  });

  protected readonly subjectProblem = computed(() =>
    this.tried() && !this.form.subjectValid()
      ? $localize`:@@webSearch.subjectShort:Escreva pelo menos 3 letras.`
      : '',
  );
  protected readonly sourcesProblem = computed(() =>
    this.form.sources() === null
      ? $localize`:@@webSearch.sourcesRange:Use um número inteiro de 1 a 30.`
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
    fieldDescribedBy('web-search-sources', { error: this.sourcesProblem() }),
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
    const problem = this.form.addAuthor(this.typedAuthor());
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
  protected search(event: Event): void {
    event.preventDefault();
    if (this.disabled() || this.loading()) return;
    this.tried.set(true);
    const request = this.request();
    if (!request) return this.focusProblem();
    this.tried.set(false);
    this.asked.set({ topic: this.topic(), request });
  }

  /** The form as a request; null while something in it is missing. */
  private request(): WebSearchRequest | null {
    // A name typed and not added yet is wanted too.
    if (this.typedAuthor().trim() !== '') {
      const problem = this.form.addAuthor(this.typedAuthor());
      this.refusedAuthor.set(problem);
      if (problem !== null) return null;
      this.typedAuthor.set('');
    }
    const sources = this.form.sources();
    const ready = this.form.subjectValid() && this.form.kinds().length > 0;
    if (!ready || sources === null) return null;
    return {
      query: this.form.subject().trim(),
      sources,
      kinds: [...this.form.kinds()],
      authors: [...this.form.authors()],
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
    this.found.reload();
  }

  protected toggle(url: string): void {
    this.selected.update((before) => {
      const after = new Set(before);
      if (!after.delete(url)) after.add(url);
      return after;
    });
  }

  protected toggleAll(): void {
    const urls = this.allSelected()
      ? []
      : this.selectable().map((row) => row.url);
    this.selected.set(new Set(urls));
  }

  protected include(): void {
    if (this.cannotInclude()) return;
    const chosen = this.rows().filter((row) => this.selected().has(row.url));
    this.selected.set(new Set<string>());
    this.picked.emit(
      chosen.map(({ url, title, kind }) => ({ url, title, kind })),
    );
  }

  /** The document the collection already has, in the conversation's reading panel. */
  protected openDocument(document: UploadedDocumentRef): void {
    this.chat.open(this.topic(), { id: document.id, title: document.title });
    void this.router.navigateByUrl('/');
  }
}

function failedView(error: unknown): View {
  const code = toUiErrorCode(error);
  if (code === 'WEB_SEARCH_NOT_CONNECTED') return { kind: 'off' };
  if (code === 'WEB_SEARCH_NO_CREDITS') return { kind: 'no-credits' };
  if (code === 'RATE_LIMITED') return { kind: 'limited' };
  return { kind: 'failed', message: errorMessage(code) };
}

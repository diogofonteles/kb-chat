import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  type Signal,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import {
  rxResource,
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  DEFAULT_LIBRARY_PREFERENCES,
  libraryHomeSchema,
  libraryPageSchema,
  listeningPreferencesSchema,
  type LibraryFilters,
  type LibraryItem,
  type LibraryPage as LibraryPageAnswer,
  type LibrarySort,
  type LibraryView,
  type ListeningPreferencesUpdate,
  type MediaItem,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  LIBRARY_HOME_URL,
  LibraryApi,
  libraryUrlOf,
  type LibraryRequest,
  type MarkOutcome,
} from '@core/media/library-api.js';
import { PREFERENCES_URL } from '@core/media/listening-api.js';
import { MediaApi } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { EMPTY, Subject, catchError, concatMap, debounceTime, of } from 'rxjs';
import { UploadPanel } from '../upload-panel.js';
import { LibraryCard } from './library-card.js';
import { LibraryControls } from './library-controls.js';
import {
  NO_FILTERS,
  activeFiltersOf,
  applyFilterChange,
  countTextOf,
  playedAgoOf,
  type FilterChange,
} from './library-labels.js';
import { LibraryRow, type RowAction } from './library-row.js';
import { NearEnd } from './near-end.js';
import { PlayNow } from './play-now.js';

/** "Buscar na biblioteca" waits this long after the last key (T16). */
export const SEARCH_DEBOUNCE_MS = 200;

/** The library's own choices, as kept in the account (BR-7). */
interface Choices {
  readonly sort: LibrarySort;
  readonly view: LibraryView;
  readonly filters: LibraryFilters;
}

/** One page after the first: of which list, and from where. */
interface NextPageAsked {
  readonly request: LibraryRequest;
  readonly cursor: string;
}

/** What the pages after the first added to the list. */
interface MorePages {
  readonly items: readonly LibraryItem[];
  readonly nextCursor: string | null;
}

/**
 * "Biblioteca" (screens.md T16, KBC-051): only the media, Spotify-like. "Continuar ouvindo"
 * resumes in one click, "Ouvidas recentemente" shows the last plays, and "Todas" holds every
 * media of every collection the person sees, with chips, search, order, list or grid and
 * "Marcar como ouvida". The choices go to the account (every device).
 */
@Component({
  selector: 'app-library-page',
  imports: [
    RouterLink,
    LibraryCard,
    LibraryControls,
    LibraryRow,
    NearEnd,
    UploadPanel,
  ],
  templateUrl: './library-page.html',
  styleUrl: './library-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusin)': 'keepInView($event)' },
})
export class LibraryPage {
  private readonly api = inject(LibraryApi);
  private readonly mediaApi = inject(MediaApi);
  private readonly session = inject(SessionStore);
  private readonly chat = inject(ChatStore);
  private readonly views = inject(ViewStore);
  private readonly engine = inject(MediaEngine);
  private readonly playNow = inject(PlayNow);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly searchBox = viewChild<ElementRef<HTMLElement>>('searchBox');
  private readonly allTitle = viewChild<ElementRef<HTMLElement>>('allTitle');
  private readonly recentsToggle =
    viewChild<ElementRef<HTMLElement>>('recentsToggle');
  private readonly clearRecentsButton =
    viewChild<ElementRef<HTMLElement>>('clearRecentsButton');
  private readonly keepRecentsButton =
    viewChild<ElementRef<HTMLElement>>('keepRecentsButton');
  private readonly selectAllBox =
    viewChild<ElementRef<HTMLElement>>('selectAllBox');
  private readonly removeDialog =
    viewChild<ElementRef<HTMLDialogElement>>('removeDialog');
  /** Saves one after the other: the account ends with the last choice (BR-7). */
  private readonly saves = new Subject<ListeningPreferencesUpdate>();
  /** "/midia" leads here with the collection that was selected (FR-7). */
  private readonly arrivedWithTopic: string | null =
    this.route.snapshot.queryParamMap.get('acervo');

  protected readonly topics = this.chat.topicList;
  protected readonly canUpload = computed(() =>
    this.session.can('media-upload'),
  );
  /** "Buscar na fala" opens the search, which is a feature of its own. */
  protected readonly canSearch = computed(() => this.session.can('search'));
  protected readonly isMaster = this.session.isMaster;

  private readonly preferences = httpResource(() => PREFERENCES_URL, {
    parse: (body) => listeningPreferencesSchema.parse(body),
  });
  /** The account's choices once read; the defaults when the account cannot be read. */
  private readonly kept = linkedSignal<Choices | null>(() => {
    if (this.preferences.isLoading()) return null;
    const kept = this.preferences.hasValue()
      ? this.preferences.value()
      : DEFAULT_LIBRARY_PREFERENCES;
    const topic = this.arrivedWithTopic ?? kept.libraryFilters.topic;
    return {
      sort: kept.librarySort,
      view: kept.libraryView,
      filters: { ...kept.libraryFilters, topic },
    };
  });
  /**
   * The choices in force, once the collections are known. A collection the person no longer
   * sees is left aside, not erased: the account keeps it for when the access comes back.
   */
  protected readonly choices = computed<Choices | null>(() => {
    const kept = this.kept();
    if (!kept || !this.chat.topicsKnown()) return null;
    const { topic } = kept.filters;
    const lost =
      topic !== null && !this.topics().some((one) => one.slug === topic);
    return lost ? { ...kept, filters: { ...kept.filters, topic: null } } : kept;
  });

  /** What is typed in "Buscar na biblioteca", and what is asked after the pause. */
  protected readonly query = signal('');
  protected readonly trimmedQuery = computed(() => this.query().trim());
  private readonly askedQuery = toSignal(
    toObservable(this.query).pipe(debounceTime(SEARCH_DEBOUNCE_MS)),
    { initialValue: '' },
  );
  /** What is asked; the view (list or grid) is not, so switching it asks nothing. */
  private readonly request = computed<LibraryRequest | null>(
    () => {
      const choices = this.choices();
      return choices
        ? {
            filters: choices.filters,
            sort: choices.sort,
            query: this.askedQuery(),
          }
        : null;
    },
    {
      equal: (a, b) => (a && b ? libraryUrlOf(a) === libraryUrlOf(b) : a === b),
    },
  );

  protected readonly home = httpResource(() => LIBRARY_HOME_URL, {
    parse: (body) => libraryHomeSchema.parse(body),
  });
  protected readonly firstPage = httpResource(
    () => {
      const request = this.request();
      return request ? libraryUrlOf(request) : undefined;
    },
    { parse: (body) => libraryPageSchema.parse(body) },
  );
  private readonly firstAnswer = computed(() =>
    this.firstPage.hasValue() ? this.firstPage.value() : null,
  );
  /** The next page asked; each new list forgets it, which cancels the one on its way. */
  private readonly nextPageAsked = linkedSignal<
    LibraryPageAnswer | null,
    NextPageAsked | null
  >({ source: this.firstAnswer, computation: () => null });
  // Null, not undefined: a resource left without params would let the old load run on.
  private readonly nextPage = rxResource<
    LibraryPageAnswer | null,
    NextPageAsked | null
  >({
    params: this.nextPageAsked,
    stream: ({ params }) =>
      params ? this.api.page(params.request, params.cursor) : of(null),
  });
  /** The pages after the first, loaded as the person scrolls; reset with each answer. */
  private readonly morePages = linkedSignal<
    {
      readonly first: LibraryPageAnswer | null;
      readonly next: LibraryPageAnswer | null;
    },
    MorePages
  >({
    source: () => ({
      first: this.firstAnswer(),
      next: this.nextPage.hasValue() ? this.nextPage.value() : null,
    }),
    computation: ({ first, next }, previous) => {
      const sameList = previous?.source.first === first;
      const kept: MorePages =
        previous && sameList
          ? previous.value
          : { items: [], nextCursor: first?.nextCursor ?? null };
      if (!next || (sameList && next === previous?.source.next)) return kept;
      return {
        items: [...kept.items, ...next.items],
        nextCursor: next.nextCursor,
      };
    },
  });
  protected readonly loadingMore = this.nextPage.isLoading;
  /** What was on screen stays there while a new answer is on its way (T16 "Erro"). */
  private readonly lastPage = linkedSignal<
    LibraryPageAnswer | null,
    LibraryPageAnswer | null
  >({
    source: this.firstAnswer,
    computation: (page, previous) => page ?? previous?.value ?? null,
  });
  protected readonly items = computed(() => [
    ...(this.lastPage()?.items ?? []),
    ...this.morePages().items,
  ]);
  protected readonly hasMore = computed(
    () => this.morePages().nextCursor !== null,
  );
  protected readonly facets = computed(
    () =>
      this.lastPage()?.facets ?? {
        states: [],
        authors: [],
        topics: [],
      },
  );
  /** "42 mídias · 31 h", read aloud at each change (aria-live, AC-14). */
  protected readonly countText = computed(() => {
    const page = this.lastPage();
    return page && !this.libraryEmpty()
      ? countTextOf(page.total, page.totalDurationMs)
      : '';
  });
  /** Nothing at all in the library (not a filter's doing). */
  protected readonly libraryEmpty = computed(
    () => this.firstPage.hasValue() && this.facets().topics.length === 0,
  );
  protected readonly nothingFound = computed(
    () => this.lastPage() !== null && this.items().length === 0,
  );
  protected readonly showSkeleton = computed(
    () =>
      !this.choices() ||
      (this.firstPage.isLoading() && this.items().length === 0),
  );
  protected readonly filtered = computed(() => {
    const choices = this.choices();
    return choices !== null && activeFiltersOf(choices.filters) > 0;
  });
  protected readonly loadError = computed(() =>
    this.firstPage.error() || this.home.error()
      ? $localize`:@@library.loadError:Não consegui carregar a Biblioteca.`
      : '',
  );

  protected readonly homeLoading = computed(
    () => !this.home.hasValue() && !this.home.error(),
  );
  protected readonly continueItems = computed(() =>
    this.home.hasValue() ? this.home.value().continueListening : [],
  );
  private readonly recentItems = computed(() =>
    this.home.hasValue() ? this.home.value().recentlyPlayed : [],
  );
  /** Each recent play with "há 2 dias", worked out once per answer. */
  protected readonly recents = computed(() => {
    const now = new Date();
    return this.recentItems().map((item) => ({
      item,
      ago: item.lastPlayedAt
        ? playedAgoOf(item.lastPlayedAt, now, this.locale)
        : '',
    }));
  });
  protected readonly recentsCleared = computed(
    () => this.home.hasValue() && this.home.value().recentsClearedAt !== null,
  );
  protected readonly showRecents = computed(
    () =>
      this.home.hasValue() &&
      (this.recents().length > 0 || this.recentsCleared()),
  );
  protected readonly recentsOpen = signal(true);
  protected readonly confirmingClear = signal(false);
  protected readonly canClearRecents = computed(
    () => this.recents().length > 0 && !this.confirmingClear(),
  );

  /** Selected media for "Marcar como ouvida/não ouvida" (only those on screen). */
  protected readonly selected = linkedSignal<
    LibraryRequest | null,
    ReadonlySet<string>
  >({
    source: this.request,
    computation: () => new Set<string>(),
  });
  protected readonly selecting = computed(() => this.selected().size > 0);
  protected readonly selectable = computed(() =>
    this.items().filter((item) => item.status === 'ready'),
  );
  protected readonly allSelected = computed(
    () =>
      this.selectable().length > 0 &&
      this.selectable().every((item) => this.selected().has(item.id)),
  );
  protected readonly selectedText = computed(() => {
    const count = this.selected().size;
    return count === 1
      ? $localize`:@@library.selectedOne:1 selecionada`
      : $localize`:@@library.selectedMany:${count}:count: selecionadas`;
  });
  protected readonly selectAllText = computed(
    () =>
      $localize`:@@library.selectAll:Selecionar todas as ${this.selectable().length}:count:`,
  );

  protected readonly uploading = signal(false);
  protected readonly removing = signal<MediaItem | null>(null);
  protected readonly actionError = signal('');
  /** The next page failed: "Mostrar mais" stays, to try again. */
  private readonly pageError = computed(() => {
    const failure = this.nextPage.error();
    return failure ? errorMessage(toUiErrorCode(failure)) : '';
  });
  protected readonly shownError = computed(
    () => this.actionError() || this.pageError(),
  );
  protected readonly announcement = signal('');
  private readonly titles = computed(
    () => new Map(this.topics().map((topic) => [topic.slug, topic.title])),
  );
  protected readonly playingId = computed(() =>
    this.engine.playing() ? (this.engine.source()?.id ?? null) : null,
  );

  constructor() {
    this.saves
      .pipe(
        concatMap((update) =>
          this.api.savePreferences(update).pipe(
            catchError(() => {
              this.actionError.set(
                $localize`:@@library.saveChoiceFailed:Não consegui guardar esta escolha na sua conta. Ela vale só neste aparelho por enquanto.`,
              );
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  /** The page scrolls in its own row: what takes the focus comes fully into view. */
  protected keepInView(event: FocusEvent): void {
    if (event.target instanceof HTMLElement)
      event.target.scrollIntoView?.({ block: 'nearest' });
  }

  protected topicTitleOf(item: LibraryItem): string {
    return this.titles().get(item.topic) ?? item.topic;
  }

  protected play(item: LibraryItem): void {
    this.playNow.play(item);
  }

  /* ---------- Choices (BR-7) ---------- */

  protected search(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }

  protected clearSearch(): void {
    this.query.set('');
    this.focusAfterRender(this.searchBox);
  }

  /** Nothing in the titles: the same words in what was said, in the search (AC-12). */
  protected searchSpoken(): void {
    const topic = this.choices()?.filters.topic;
    if (topic) this.chat.selectTopic(topic);
    this.views.select('search');
    this.chat.ask(this.trimmedQuery(), { kinds: ['audio'] });
    void this.router.navigateByUrl('/');
  }

  /** A control's change, applied to the filters held now (BR-7). */
  protected changeFilter(change: FilterChange): void {
    const current = this.choices();
    if (current) this.changeFilters(applyFilterChange(current.filters, change));
    if (change.kind === 'clear') this.focusAfterRender(this.allTitle);
  }

  private changeFilters(filters: LibraryFilters): void {
    this.choose({ filters }, { libraryFilters: filters });
  }

  protected clearFilters(): void {
    this.changeFilters(NO_FILTERS);
    this.focusAfterRender(this.allTitle);
  }

  /** "Ver tudo" of "Continuar ouvindo": "Todas" with only what is in progress. */
  protected showInProgress(): void {
    this.changeFilters({
      states: ['in-progress'],
      authors: [],
      topic: null,
    });
  }

  protected changeSort(sort: LibrarySort): void {
    this.choose({ sort }, { librarySort: sort });
  }

  protected changeView(view: LibraryView): void {
    this.choose({ view }, { libraryView: view });
  }

  private choose(
    change: Partial<Choices>,
    update: ListeningPreferencesUpdate,
  ): void {
    const current = this.choices();
    if (!current) return;
    this.kept.set({ ...current, ...change });
    this.saves.next(update);
  }

  /* ---------- Pages ---------- */

  protected loadMore(): void {
    const request = this.request();
    const cursor = this.morePages().nextCursor;
    if (request && cursor && !this.loadingMore())
      this.nextPageAsked.set({ request, cursor });
  }

  protected reload(): void {
    this.firstPage.reload();
    this.home.reload();
  }

  /* ---------- "Continuar ouvindo" strip ---------- */

  /** ◂ ▸: one card width at a time (also by keyboard, UP-09). */
  protected scrollStrip(direction: 1 | -1): void {
    const strip = this.strip()?.nativeElement;
    strip?.scrollBy({ left: direction * strip.clientWidth * 0.8 });
  }

  /* ---------- Recents (BR-4) ---------- */

  protected toggleRecents(): void {
    this.recentsOpen.update((open) => !open);
  }

  protected askClearRecents(): void {
    this.confirmingClear.set(true);
    this.focusAfterRender(this.keepRecentsButton);
  }

  protected cancelClearRecents(): void {
    this.confirmingClear.set(false);
    this.focusAfterRender(this.clearRecentsButton);
  }

  protected clearRecents(): void {
    this.confirmingClear.set(false);
    this.focusAfterRender(this.recentsToggle);
    this.api
      .clearRecents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.home.reload();
          this.announcement.set(
            $localize`:@@library.recentsCleared:Ouvidas recentemente foram limpas.`,
          );
        },
        error: () =>
          this.actionError.set(
            $localize`:@@library.clearFailed:Não consegui limpar as ouvidas recentemente. Tente de novo.`,
          ),
      });
  }

  /* ---------- Selection and marking (FR-3, BR-5) ---------- */

  protected select(item: LibraryItem, on: boolean): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (on) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  }

  protected toggleAll(event: Event): void {
    const on = event.target instanceof HTMLInputElement && event.target.checked;
    this.selected.set(
      on ? new Set(this.selectable().map((item) => item.id)) : new Set(),
    );
  }

  protected cancelSelection(): void {
    this.selected.set(new Set());
    this.focusAfterRender(this.selectAllBox);
  }

  protected markSelected(played: boolean): void {
    this.mark([...this.selected()], played);
  }

  protected rowAction(item: LibraryItem, action: RowAction): void {
    if (action === 'remove') this.askRemove(item);
    else this.mark([item.id], action === 'mark-played');
  }

  private mark(ids: readonly string[], played: boolean): void {
    if (ids.length === 0) return;
    this.actionError.set('');
    this.api
      .markPlayedInBatches(ids, played)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.marked(ids, played, outcome));
  }

  private marked(
    ids: readonly string[],
    played: boolean,
    { applied, unsent }: MarkOutcome,
  ): void {
    if (unsent.length === ids.length) {
      this.actionError.set(markFailedTextOf(played));
      return;
    }
    const wasSelecting = this.selecting();
    const pending = new Set(unsent);
    const handled = new Set(ids.filter((id) => !pending.has(id)));
    this.selected.update(
      (current) => new Set([...current].filter((id) => !handled.has(id))),
    );
    this.reload();
    if (unsent.length > 0) {
      this.actionError.set(
        `${markedTextOf(applied.length, played)} ${missingTextOf(unsent.length)}`,
      );
      return;
    }
    this.announcement.set(markedTextOf(applied.length, played));
    // The selection bar left, or a filter may take the row away with its menu.
    if ((wasSelecting && !this.selecting()) || this.filtered())
      this.focusAfterRender(this.allTitle);
  }

  /** The control pressed may be gone: the focus never falls to the page (WCAG 2.4.3). */
  private focusAfterRender(
    target: Signal<ElementRef<HTMLElement> | undefined>,
  ): void {
    afterNextRender(
      () =>
        (target() ?? this.allTitle() ?? this.heading()).nativeElement.focus(),
      { injector: this.injector },
    );
  }

  /* ---------- Upload (T14) and the masters' actions ---------- */

  protected openUpload(): void {
    this.uploading.set(true);
  }

  protected uploadClosed(): void {
    this.uploading.set(false);
  }

  protected uploaded(): void {
    this.firstPage.reload();
  }

  protected retry(item: LibraryItem): void {
    this.actionError.set('');
    this.mediaApi
      .retry(item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.firstPage.reload(),
        error: (err: unknown) =>
          this.actionError.set(errorMessage(toUiErrorCode(err))),
      });
  }

  private askRemove(item: LibraryItem): void {
    this.removing.set(item);
    afterNextRender(() => this.removeDialog()?.nativeElement.showModal(), {
      injector: this.injector,
    });
  }

  protected confirmRemove(): void {
    const item = this.removing();
    this.removeDialog()?.nativeElement.close();
    if (!item) return;
    this.mediaApi
      .remove(item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.reload();
          this.announcement.set(
            $localize`:@@media.removedAnnouncement:${item.title}:title: foi removido.`,
          );
          this.heading().nativeElement.focus();
        },
        error: (err: unknown) =>
          this.actionError.set(errorMessage(toUiErrorCode(err))),
      });
  }

  protected cancelRemove(): void {
    this.removeDialog()?.nativeElement.close();
  }

  protected removeClosed(): void {
    this.removing.set(null);
  }

  protected readonly selectedTopic = computed(
    () => this.chat.topicSlug() ?? '',
  );
}

function markFailedTextOf(played: boolean): string {
  return played
    ? $localize`:@@library.markFailed:Não consegui marcar como ouvida. Tente de novo.`
    : $localize`:@@library.unmarkFailed:Não consegui marcar como não ouvida. Tente de novo.`;
}

/** After the first batches went through and a later one failed (FR-3). */
function missingTextOf(count: number): string {
  return $localize`:@@library.markMissing:Faltaram ${count}:count:: tente de novo.`;
}

/** "2 mídias marcadas como ouvidas." in the status region, after a mark (FR-3). */
function markedTextOf(count: number, played: boolean): string {
  if (count === 1)
    return played
      ? $localize`:@@library.markedPlayedOne:1 mídia marcada como ouvida.`
      : $localize`:@@library.markedUnplayedOne:1 mídia marcada como não ouvida.`;
  return played
    ? $localize`:@@library.markedPlayedMany:${count}:count: mídias marcadas como ouvidas.`
    : $localize`:@@library.markedUnplayedMany:${count}:count: mídias marcadas como não ouvidas.`;
}

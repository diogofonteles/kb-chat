import { Location } from '@angular/common';
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
import {
  ActivatedRoute,
  NavigationEnd,
  NavigationStart,
  Router,
  RouterLink,
  type UrlTree,
  convertToParamMap,
} from '@angular/router';
import {
  DEFAULT_LIBRARY_PREFERENCES,
  LIBRARY_QUERY_MAX,
  libraryHomeSchema,
  libraryPageSchema,
  listeningPreferencesSchema,
  type LibraryFilters,
  type LibraryItem,
  type LibraryPage as LibraryPageAnswer,
  type LibrarySort,
  type LibraryView,
  type ListeningPreferencesUpdate,
  type ListeningState,
  type MediaItem,
  type MediaMark,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { TrackGroup } from './track-group.js';
import { alsoRemovesText, tracksInTheWay } from '../track-removal.js';
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
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  debounceTime,
  filter,
  map,
  of,
  share,
} from 'rxjs';
import { keepFocusedInView } from '../keep-in-view.js';
import { detailsSavedText } from '../edit-labels.js';
import { EditMediaDialog, type MediaEdited } from '../edit-media-dialog.js';
import { MovedNotice, mediaMoveOf, type MediaMove } from '../moved-notice.js';
import { injectOpenPreparations } from '../preparation/open-preparations.js';
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
import { LibrarySearchResults } from './library-search-results.js';
import { NearEnd } from './near-end.js';
import { PlayNow } from './play-now.js';

/** "Buscar na biblioteca" waits this long after the last key (T16). */
export const SEARCH_DEBOUNCE_MS = 200;

/** The address is typed by anyone: one value, never more than a search takes. */
const wordsOf = (param: string | null | undefined): string =>
  (param ?? '').slice(0, LIBRARY_QUERY_MAX);

/** An address without its query and fragment. */
const pathOf = (url: string): string => url.split(/[?#]/)[0] ?? '';

/** The words in the address: back from a result, the search is still there (KBC-096). */
const SEARCH_PARAM = 'busca';

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
    EditMediaDialog,
    LibraryCard,
    LibraryControls,
    LibraryRow,
    LibrarySearchResults,
    MovedNotice,
    NearEnd,
    TrackGroup,
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
  private readonly engine = inject(MediaEngine);
  private readonly playNow = inject(PlayNow);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
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
  /** Where each preparation stopped (KBC-072 FR-6). */
  protected readonly preparations = injectOpenPreparations();
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
  /** The kept collection, when the person no longer sees it. */
  private readonly lostTopic = computed(() => {
    const topic = this.kept()?.filters.topic ?? null;
    const seen = this.topics().some((one) => one.slug === topic);
    return seen ? null : topic;
  });
  /** The kept subject, when the person no longer sees subjects (KBC-070 BR-3). */
  private readonly lostSubject = computed(() => {
    const seesSubjects =
      this.session.can('media-tracks') && this.session.can('media-subjects');
    return seesSubjects ? null : (this.kept()?.filters.subject ?? null);
  });
  /**
   * The choices in force, once the collections are known. A collection the person no longer
   * sees, or a subject, is left aside, not erased: the account keeps it for when the access
   * comes back.
   */
  protected readonly choices = computed<Choices | null>(() => {
    const kept = this.kept();
    if (!kept || !this.chat.topicsKnown()) return null;
    const { topic, subject } = kept.filters;
    const filters = {
      ...kept.filters,
      topic: this.lostTopic() ? null : topic,
      subject: this.lostSubject() ? null : subject,
    };
    return { ...kept, filters };
  });

  /** What is typed in "Buscar na biblioteca", and what is asked after the pause. */
  protected readonly query = signal(
    wordsOf(this.route.snapshot.queryParamMap.get(SEARCH_PARAM)),
  );
  protected readonly trimmedQuery = computed(() => this.query().trim());
  /** Each pause in the typing, even back to the same words: the address may have moved. */
  private readonly pauses = toObservable(this.query).pipe(
    debounceTime(SEARCH_DEBOUNCE_MS),
    share(),
  );
  protected readonly askedQuery = toSignal(this.pauses, {
    initialValue: this.query(),
  });
  /** The address as this page left it, to tell a navigation from its own writes. */
  private lastWordsInAddress = this.query().trim();
  /** The library's own path: a write never lands on another page's address (QA BUG-11). */
  private readonly ownPath = pathOf(this.router.url);
  /** Any text in the box: the page is its results from the first key (KBC-096). */
  protected readonly searching = computed(() => this.trimmedQuery() !== '');
  /** What is asked; the view (list or grid) is not, so switching it asks nothing. */
  private readonly request = computed<LibraryRequest | null>(
    () => {
      const choices = this.choices();
      return choices
        ? {
            filters: choices.filters,
            sort: choices.sort,
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
        subjects: [],
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
    { request: LibraryRequest | null; searching: boolean },
    ReadonlySet<string>
  >({
    source: computed(
      () => ({ request: this.request(), searching: this.searching() }),
      {
        equal: (a, b) => a.request === b.request && a.searching === b.searching,
      },
    ),
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
  /** The tracks that go with it, once the API named them (KBC-068). */
  protected readonly removingTracks = signal<readonly string[] | null>(null);
  protected readonly removingTracksText = computed(() =>
    alsoRemovesText(this.removingTracks() ?? []),
  );
  protected readonly editing = signal<LibraryItem | null>(null);
  /** The last audio moved from here (KBC-050 FR-3). */
  protected readonly moved = signal<MediaMove | null>(null);
  protected readonly movedQuery = computed(() => ({
    acervo: this.moved()?.topic,
  }));
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
    this.followAddress();
  }

  /** The words and the address, each following the other (KBC-096). */
  private followAddress(): void {
    this.pauses
      .pipe(
        filter((words) => words.trim() !== this.wordsInAddress()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((words) => this.keepWordsInAddress(words.trim()));
    // A link followed before the pause: the words typed stay in this entry, for Back.
    this.router.events
      .pipe(
        filter(
          (event): event is NavigationStart =>
            event instanceof NavigationStart &&
            event.navigationTrigger === 'imperative' &&
            pathOf(event.url) !== this.ownPath,
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.keepTypedWordsOnLeaving());
    // "Biblioteca" in the sidebar, or Back: the address says what is on screen.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        map(() => this.wordsInAddress()),
        filter((words) => words !== this.lastWordsInAddress),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((words) => {
        this.lastWordsInAddress = words;
        this.query.set(words);
      });
  }

  /** On another page, or on the way to one: a write would replace that page's address. */
  private isAway(): boolean {
    const going = this.router.currentNavigation()?.extractedUrl;
    const here = pathOf(this.router.url);
    return (
      here !== this.ownPath || (!!going && pathOf(going.toString()) !== here)
    );
  }

  private wordsInAddress(): string {
    const { queryParams } = this.router.parseUrl(this.router.url);
    return wordsOf(convertToParamMap(queryParams).get(SEARCH_PARAM));
  }

  private addressWith(words: string): UrlTree {
    const address = this.router.parseUrl(this.router.url);
    const others = Object.entries(address.queryParams).filter(
      ([name]) => name !== SEARCH_PARAM,
    );
    address.queryParams = Object.fromEntries([
      ...others,
      ...(words ? [[SEARCH_PARAM, words]] : []),
    ]);
    return address;
  }

  /** Replaces the entry: Back leaves the library, not one word at a time. */
  private keepWordsInAddress(words: string): void {
    if (this.isAway()) return;
    this.lastWordsInAddress = words;
    void this.router.navigateByUrl(this.addressWith(words), {
      replaceUrl: true,
    });
  }

  /**
   * Leaving before the pause: the browser still shows this page's entry, so the typed words
   * go into it without a navigation, and Back finds them.
   */
  private keepTypedWordsOnLeaving(): void {
    const words = this.trimmedQuery();
    if (words === this.wordsInAddress()) return;
    this.lastWordsInAddress = words;
    this.location.replaceState(
      this.router.serializeUrl(this.addressWith(words)),
    );
  }

  protected keepInView(event: FocusEvent): void {
    keepFocusedInView(event);
  }

  protected topicTitleOf(item: LibraryItem): string {
    return this.titles().get(item.topic) ?? item.topic;
  }

  protected play(item: MediaItem): void {
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

  /** A control's change, applied to the filters held now (BR-7). */
  protected changeFilter(change: FilterChange): void {
    const current = this.choices();
    if (!current) return;
    const filters = applyFilterChange(current.filters, change);
    // Choosing a collection replaces the kept one; only that does.
    if (change.kind === 'topic') this.saveFilters(filters);
    else this.changeFilters(filters);
    if (change.kind === 'clear') this.focusAfterRender(this.allTitle);
  }

  /** Any change but the collection's: a lost collection stays for when access returns. */
  private changeFilters(filters: LibraryFilters): void {
    const topic = filters.topic ?? this.lostTopic();
    this.saveFilters({ ...filters, topic });
  }

  private saveFilters(chosen: LibraryFilters): void {
    const subject = chosen.subject ?? this.lostSubject();
    const filters = { ...chosen, subject };
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
      subject: null,
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
    const current = this.kept();
    if (!current || !this.choices()) return;
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
    else if (action === 'edit') this.openEdit(item);
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
    { marks, unsent }: MarkOutcome,
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
    // A state filter drops what changed state; a skipped media is gone or no longer ready.
    const rowsMayLeave =
      (this.choices()?.filters.states.length ?? 0) > 0 ||
      marks.length < handled.size;
    if (rowsMayLeave) this.reload();
    else this.showMarks(marks, played);
    if (unsent.length > 0) {
      this.actionError.set(
        `${markedTextOf(marks.length, played)} ${missingTextOf(unsent.length)}`,
      );
      return;
    }
    this.announcement.set(markedTextOf(marks.length, played));
    // The selection bar left, or the row may leave along with its ⋯.
    if ((wasSelecting && !this.selecting()) || rowsMayLeave)
      this.focusAfterRender(this.allTitle);
  }

  /** The rows change in place: asking again would fold the pages already loaded. */
  private showMarks(marks: readonly MediaMark[], played: boolean): void {
    const byId = new Map(marks.map((mark) => [mark.id, mark]));
    const marked = (item: LibraryItem): LibraryItem => {
      const mark = byId.get(item.id);
      return mark ? withMark(item, mark) : item;
    };
    const state: ListeningState = played ? 'heard' : 'unheard';
    this.lastPage.update(
      (page) =>
        page && {
          ...page,
          items: page.items.map(marked),
          facets: {
            ...page.facets,
            states: [...new Set([...page.facets.states, state])],
          },
        },
    );
    this.morePages.update((more) => ({
      ...more,
      items: more.items.map(marked),
    }));
    this.home.reload();
  }

  /** The control pressed may be gone: the focus never falls to the page (WCAG 2.4.3). */
  private focusAfterRender(
    target: Signal<ElementRef<HTMLElement> | undefined>,
  ): void {
    afterNextRender(
      () =>
        (
          target() ??
          this.allTitle() ??
          this.searchBox() ??
          this.heading()
        ).nativeElement.focus(),
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

  private openEdit(item: LibraryItem): void {
    this.moved.set(null);
    this.editing.set(item);
  }

  protected editClosed(): void {
    this.editing.set(null);
  }

  /** A new title changes the row in place; a new author or collection changes the lists. */
  protected edited({ before, after }: MediaEdited): void {
    const moved = before.topic !== after.topic;
    if (!moved && before.author?.slug === after.author?.slug) {
      this.showTitle(after);
      this.announcement.set(detailsSavedText());
      return;
    }
    this.reload();
    this.focusAfterRender(this.allTitle);
    const move = moved ? mediaMoveOf(after, this.topics()) : null;
    this.moved.set(move);
    this.announcement.set(move?.text ?? detailsSavedText());
  }

  /** Asking again would fold the pages already loaded, and the row with its ⋯. */
  private showTitle({ id, title }: MediaItem): void {
    const titled = (item: LibraryItem): LibraryItem =>
      item.id === id ? { ...item, title } : item;
    this.lastPage.update(
      (page) => page && { ...page, items: page.items.map(titled) },
    );
    this.morePages.update((more) => ({
      ...more,
      items: more.items.map(titled),
    }));
    this.home.reload();
  }

  protected openMovedTopic(topic: string): void {
    this.changeFilter({ kind: 'topic', topic });
  }

  private askRemove(item: LibraryItem): void {
    this.removing.set(item);
    this.showRemoveDialog();
  }

  private showRemoveDialog(): void {
    afterNextRender(() => this.removeDialog()?.nativeElement.showModal(), {
      injector: this.injector,
    });
  }

  protected confirmRemove(): void {
    const item = this.removing();
    const cascade = this.removingTracks() !== null;
    this.removeDialog()?.nativeElement.close();
    if (!item) return;
    this.mediaApi
      .remove(item.id, { cascade })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.reload();
          this.announcement.set(
            $localize`:@@media.removedAnnouncement:${item.title}:title: foi removido.`,
          );
          this.heading().nativeElement.focus();
        },
        error: (err: unknown) => this.removeRefused(item, err),
      });
  }

  /** It has tracks: the dialog comes back naming them (KBC-068). */
  private removeRefused(item: MediaItem, err: unknown): void {
    const tracks = tracksInTheWay(err);
    if (!tracks) {
      this.actionError.set(errorMessage(toUiErrorCode(err)));
      return;
    }
    this.removing.set(item);
    this.removingTracks.set(tracks);
    this.showRemoveDialog();
  }

  protected cancelRemove(): void {
    this.removeDialog()?.nativeElement.close();
  }

  protected removeClosed(): void {
    this.removing.set(null);
    this.removingTracks.set(null);
  }

  protected readonly selectedTopic = computed(
    () => this.chat.topicSlug() ?? '',
  );
}

/** The item as the server left it: a mark also puts the position back to 0 (BR-5). */
function withMark(item: LibraryItem, mark: MediaMark): LibraryItem {
  const { completedAt, positionUpdatedAt } = mark;
  return { ...item, positionMs: 0, completedAt, positionUpdatedAt };
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
  if (count === 0)
    return $localize`:@@library.markedNone:Nada mudou: estas mídias não estão mais disponíveis.`;
  if (count === 1)
    return played
      ? $localize`:@@library.markedPlayedOne:1 mídia marcada como ouvida.`
      : $localize`:@@library.markedUnplayedOne:1 mídia marcada como não ouvida.`;
  return played
    ? $localize`:@@library.markedPlayedMany:${count}:count: mídias marcadas como ouvidas.`
    : $localize`:@@library.markedUnplayedMany:${count}:count: mídias marcadas como não ouvidas.`;
}

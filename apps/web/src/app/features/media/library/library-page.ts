import { Location } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  type Signal,
  type TemplateRef,
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
  NO_AUTHOR,
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
  type Topic,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { TrackGroup } from './track-group.js';
import { scrollPageByKey } from '../page-keys.js';
import {
  alsoRemovesCount,
  alsoRemovesText,
  trackListRows,
  tracksInTheWay,
} from '../track-removal.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  LibraryApi,
  libraryHomeUrlOf,
  libraryUrlOf,
  type LibraryRequest,
  type MarkOutcome,
} from '@core/media/library-api.js';
import { PREFERENCES_URL } from '@core/media/listening-api.js';
import { MediaApi } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  CollectionHeading,
  type HeadingScope,
} from '@features/chat/collection-heading.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  debounceTime,
  filter,
  map,
  of,
  pairwise,
  share,
  take,
} from 'rxjs';
import { keepFocusedInView } from '../keep-in-view.js';
import { detailsSavedText } from '../edit-labels.js';
import { EditMediaDialog, type MediaEdited } from '../edit-media-dialog.js';
import { MovedNotice, mediaMoveOf, type MediaMove } from '../moved-notice.js';
import { injectOpenPreparations } from '../preparation/open-preparations.js';
import { QueueSummary } from '../queue/queue-summary.js';
import { UploadPanel } from '../upload-panel.js';
import { LibraryCard } from './library-card.js';
import { LibraryControls } from './library-controls.js';
import {
  NO_FILTERS,
  STATE_CHIP_LABELS,
  activeFiltersOf,
  applyFilterChange,
  countTextOf,
  type FilterChange,
} from './library-labels.js';
import { LibraryRow, type RowAction } from './library-row.js';
import { LibrarySortMenu, type LibraryDisplay } from './library-sort.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PageHeader } from '@features/shell/page-header.js';
import { LibrarySearchResults } from './library-search-results.js';
import { NearEnd } from './near-end.js';
import { PlayNow } from './play-now.js';
import { UiBanner } from '@ui/banner.js';
import { UiButton, UiIconButton } from '@ui/button.js';
import { UiCover } from '@ui/cover.js';
import { UiEmptyState } from '@ui/empty-state.js';
import { UiIcon } from '@ui/icon.js';

/** The library's own colour, its cover's (v2 media-library LIB_TINT; library-page.css). */
const LIBRARY_TINT = '#7a3d22';

/** The shell's phone layout (chat-page: desktop from 1024 px). */
const PHONE_QUERY = '(max-width: 1023px)';
/** "Compacta" (media-library-sort): a density of the list, kept in this browser only. */
const COMPACT_KEY = 'kb-chat.library.compact';
function readCompact(): boolean {
  try {
    return globalThis.localStorage?.getItem(COMPACT_KEY) === '1';
  } catch {
    return false;
  }
}
function keepCompact(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(COMPACT_KEY, '1');
    else globalThis.localStorage?.removeItem(COMPACT_KEY);
  } catch {
    // No storage (a private window): the choice lasts while the page is open.
  }
}

const phoneNow = (): boolean =>
  typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;

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

/**
 * Where the list is (KBC-091): every collection, one named by a link, or, by default, the one
 * selected in the sidebar.
 */
type Scope =
  | { readonly kind: 'all' }
  | { readonly kind: 'topic'; readonly slug: string }
  | { readonly kind: 'selected' };

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
 * "Biblioteca" (screens.md T16, KBC-051; v2 KBC-128): only the media, as a playlist — the
 * header with its cover, the green ▶, "Precisa da sua atenção", the track table or the grid. "Continuar ouvindo"
 * resumes in one click, "Ouvidas recentemente" shows the last plays, and "Todas" holds the
 * media of the selected collection (KBC-091), or of all of them by choice, with chips,
 * search, order, list or grid and "Marcar como ouvida". The choices go to the account.
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
    LibrarySortMenu,
    MenuButton,
    MovedNotice,
    NearEnd,
    QueueSummary,
    TrackGroup,
    UiBanner,
    UiButton,
    UiCover,
    UiEmptyState,
    UiIcon,
    UiIconButton,
    UploadPanel,
  ],
  templateUrl: './library-page.html',
  styleUrl: './library-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(focusin)': 'keepInView($event)',
    '(document:keydown)': 'pageKey($event)',
  },
})
export class LibraryPage {
  private readonly api = inject(LibraryApi);
  private readonly mediaApi = inject(MediaApi);
  private readonly session = inject(SessionStore);
  private readonly chat = inject(ChatStore);
  private readonly collectionHeading = inject(CollectionHeading);
  private readonly engine = inject(MediaEngine);
  private readonly playNow = inject(PlayNow);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly phoneActions =
    viewChild<TemplateRef<unknown>>('phoneActions');
  private readonly searchBox = viewChild<ElementRef<HTMLElement>>('searchBox');
  private readonly allTitle = viewChild<ElementRef<HTMLElement>>('allTitle');
  private readonly searchResults = viewChild(LibrarySearchResults);
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
    return {
      sort: kept.librarySort,
      view: kept.libraryView,
      filters: kept.libraryFilters,
    };
  });
  /** A change of collection in the sidebar brings the list along, even from "Todos". */
  private readonly scope = linkedSignal<
    { readonly ready: boolean; readonly slug: string | null },
    Scope
  >({
    source: () => ({
      ready: this.kept() !== null,
      slug: this.chat.topicSlug(),
    }),
    computation: ({ ready, slug }, previous) => {
      if (!ready || !previous?.source.ready) return this.startingScope();
      const before = previous.source.slug;
      return before === slug || before === null
        ? previous.value
        : { kind: 'selected' };
    },
  });
  /** The kept collection, when the person no longer sees it. */
  private readonly lostTopic = computed(() => {
    const topic = this.kept()?.filters.topic ?? null;
    return this.sees(topic) ? null : topic;
  });
  /** The kept subject, when the person no longer sees subjects (KBC-070 BR-3). */
  private readonly lostSubject = computed(() => {
    const seesSubjects =
      this.session.can('media-tracks') && this.session.can('media-subjects');
    return seesSubjects ? null : (this.kept()?.filters.subject ?? null);
  });
  /**
   * The choices in force, once the collections are known. The collection comes from where
   * the list is; a kept one the person no longer sees, or a subject, is left aside, not
   * erased: the account keeps it for when the access comes back.
   */
  protected readonly choices = computed<Choices | null>(() => {
    const kept = this.kept();
    if (!kept || !this.chat.topicsKnown()) return null;
    const filters = {
      ...kept.filters,
      topic: this.topicInForce(),
      allTopics: this.scope().kind === 'all',
      subject: this.lostSubject() ? null : kept.filters.subject,
    };
    return { ...kept, filters };
  });
  /** What the header names (KBC-091). */
  private readonly headingScope = computed<HeadingScope | null>(() => {
    const choices = this.choices();
    if (!choices) return null;
    const { topic } = choices.filters;
    return topic ? { kind: 'topic', slug: topic } : { kind: 'all' };
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

  /** Only the collection changes the strips: a chip or the order asks nothing here. */
  private readonly homeUrl = computed(() => {
    const choices = this.choices();
    return choices ? libraryHomeUrlOf(choices.filters.topic) : undefined;
  });
  protected readonly home = httpResource(() => this.homeUrl(), {
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
  /**
   * "Precisa da sua atenção" over a list with something in it: the search, an empty
   * collection and an empty library leave it out (media-library-search, -collection-empty,
   * -empty-*); the queue stays a tap away in the sidebar's "Fila de processamento".
   */
  protected readonly showQueue = computed(
    () =>
      !this.searching() &&
      !this.nothingFound() &&
      !this.libraryEmpty() &&
      !this.tracksOpen(),
  );
  protected readonly showSkeleton = computed(
    () =>
      !this.choices() ||
      (this.firstPage.isLoading() && this.items().length === 0),
  );
  /** A collection with nothing here: the way out is the others. */
  protected readonly canSeeAll = computed(
    () => (this.choices()?.filters.topic ?? null) !== null,
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
  protected readonly confirmingClear = signal(false);
  protected readonly canClearRecents = computed(
    () => this.recentItems().length > 0 && !this.confirmingClear(),
  );
  /** A phone (the shell's layout below 1024 px): the rows' ⋯ offers "Selecionar". */
  protected readonly phone = signal(phoneNow());
  /** The phone's search row, opened by the top row's 🔍 (media-library-search@mobile). */
  protected readonly searchOpen = signal(false);
  /**
   * "Continuar ouvindo" (media-library-sort): the plain list only — no filter, no search, no
   * selection (media-library-selection) — and, on a narrow main panel, not at all
   * (media-library: the right panel open; CSS).
   */
  protected readonly showContinue = computed(
    () =>
      this.continueItems().length > 0 &&
      !this.searching() &&
      !this.selecting() &&
      !this.filtered() &&
      !this.libraryEmpty() &&
      !this.tracksOpen(),
  );
  /** "Compacta": the list without covers (media-library-sort's "Ver como"). */
  private readonly compact = signal(readCompact());
  protected readonly display = computed<LibraryDisplay>(() => {
    const view = this.choices()?.view ?? 'list';
    return view === 'list' && this.compact() ? 'compact' : view;
  });
  /**
   * The phone's sort sheet ends with "Limpar recentes" while the order is "Ouvidas
   * recentemente" (the header's ⋯ of the desktop has no place in media-library@mobile).
   */
  protected readonly phoneClearRecents = computed(
    () =>
      this.phone() &&
      this.canClearRecents() &&
      this.choices()?.sort === 'recently-played',
  );
  protected readonly titleHead = $localize`:@@library.col.title:Título`;
  protected readonly searchPlaceholder = computed(() =>
    this.phone()
      ? $localize`:@@library.searchPlaceholderPhone:Buscar na fala, título, autor`
      : $localize`:@@library.searchPlaceholder:Buscar na biblioteca (fala, título, autor)`,
  );
  protected readonly emptyUploaderText = computed(() =>
    this.phone()
      ? $localize`:@@library.emptyUploaderTextPhone:Aulas e palestras viram mídia com transcrição, busca na fala e marcadores.`
      : $localize`:@@library.emptyUploaderText:Aulas, palestras e conversas viram mídia com transcrição, busca na fala e marcadores.`,
  );
  protected readonly emptyReaderText = computed(() =>
    this.phone()
      ? $localize`:@@library.emptyReaderTextPhone:Os áudios dos acervos liberados para você aparecem aqui.`
      : $localize`:@@library.emptyReaderText:Os áudios dos acervos liberados para você aparecem aqui assim que forem enviados.`,
  );
  protected readonly otherViewLabel = computed(() =>
    this.choices()?.view === 'grid'
      ? $localize`:@@library.showList:Ver como lista`
      : $localize`:@@library.showGrid:Ver como grade`,
  );
  /** The header's ⋯ (media-library): what has no icon of its own in the action bar. */
  protected readonly headerOptions = computed<readonly MenuOption[]>(() => [
    {
      id: 'bookmarks',
      label: $localize`:@@bookmarks.mine:Meus marcadores`,
      icon: 'bookmark',
    },
    ...(this.selectable().length > 0
      ? [
          {
            id: 'select',
            label: $localize`:@@library.selectMany:Selecionar mídias`,
            icon: 'checkcircle' as const,
          },
        ]
      : []),
    ...(this.canClearRecents()
      ? [
          {
            id: 'clear-recents',
            label: $localize`:@@library.clearRecents:Limpar recentes`,
            icon: 'close' as const,
          },
        ]
      : []),
  ]);

  /** The recordings whose tracks show under their row (media-library-tracks). */
  protected readonly openTracks = signal<ReadonlySet<string>>(new Set());
  /**
   * A recording's tracks are open: the list is the page, without the attention cards and
   * "Continuar ouvindo" over it (media-library-tracks, both widths).
   */
  private readonly tracksOpen = computed(() => this.openTracks().size > 0);

  protected toggleTracks(id: string): void {
    this.openTracks.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

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
  protected readonly removingTracksCount = computed(() =>
    alsoRemovesCount(this.removingTracks()?.length ?? 0),
  );
  protected readonly removingTracksShown = computed(() =>
    trackListRows(this.removingTracks() ?? []),
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
  /** The header's line: where the list is and what it holds (v2 media-library). */
  protected readonly headerMeta = computed(() => {
    const filters = this.choices()?.filters ?? null;
    const topic = filters?.topic ?? null;
    // A filter of one state or one author names what the list is (media-library-chip,
    // -author: "Em andamento · 3 mídias", "Irmã Helena Prado · 5 mídias").
    const state = filters?.states.length === 1 ? filters.states[0] : null;
    const author = filters?.authors.length === 1 ? filters.authors[0] : null;
    const where = state
      ? STATE_CHIP_LABELS[state]()
      : author
        ? author === NO_AUTHOR
          ? $localize`:@@authorship.others:Outros autores`
          : (this.facets().authors.find((one) => one.slug === author)?.name ??
            author)
        : topic
          ? (this.titles().get(topic) ?? topic)
          : $localize`:@@library.allCollections:Todos os acervos`;
    if (this.libraryEmpty())
      return $localize`:@@library.nothingYet:Nenhuma mídia por enquanto`;
    const count = this.countText();
    return count ? `${where} · ${count}` : where;
  });
  /** What the green ▶ plays: the first ready media of the list on screen. */
  protected readonly firstPlayable = computed(
    () => this.items().find((item) => item.status === 'ready') ?? null,
  );
  /** A media of the list is playing: the green ▶ pauses it. */
  private readonly playingItem = computed(() => {
    const id = this.playingId();
    return id === null
      ? null
      : (this.items().find((item) => item.id === id) ?? null);
  });
  protected readonly listPlaying = computed(() => this.playingItem() !== null);
  protected readonly playAllLabel = computed(() =>
    this.listPlaying()
      ? $localize`:@@library.pauseList:Pausar a lista`
      : $localize`:@@library.playList:Tocar a primeira da lista`,
  );
  protected readonly nothingFoundTitle = computed(() =>
    this.filtered()
      ? $localize`:@@library.filtersEmpty:Nenhuma mídia com estes filtros`
      : $localize`:@@library.collectionEmpty:Nenhuma mídia neste acervo`,
  );
  protected readonly nothingFoundText = computed(() => {
    // The phone's empty collection is its title and the way out (-collection-empty@mobile).
    if (this.filtered() || this.phone()) return '';
    const topic = this.choices()?.filters.topic ?? null;
    const name = topic ? (this.titles().get(topic) ?? null) : null;
    return name
      ? $localize`:@@library.collectionEmptyNamed:Quando alguém enviar um áudio para ${name}:name:, ele aparece aqui.`
      : $localize`:@@library.collectionEmptyText:Quando alguém enviar um áudio para este acervo, ele aparece aqui.`;
  });

  constructor() {
    this.followCollection();
    inject(PageHeader).own(
      computed(() => ({
        title: $localize`:@@library.title:Biblioteca`,
        back: null,
        actions: this.phoneActions() ?? null,
        tint: LIBRARY_TINT,
      })),
    );
    this.followLayout();
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

  /** The shell's breakpoint: below it, the phone's layout (the rows' ⋯ changes). */
  private followLayout(): void {
    const query =
      this.host.ownerDocument.defaultView?.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) =>
      this.phone.set(event.matches);
    query.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() =>
      query.removeEventListener('change', onChange),
    );
  }

  /** The header, the sidebar and the account say the collection the list shows (KBC-091). */
  private followCollection(): void {
    this.collectionHeading.follow(this.headingScope);
    // A link to a collection is a choice of it: the sidebar says the same as the list.
    toObservable(this.chat.topicsKnown)
      .pipe(filter(Boolean), take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.selectArrivedTopic());
    // The sidebar took the list out of "Todos os acervos": the account forgets it too.
    toObservable(this.scope)
      .pipe(
        pairwise(),
        filter(
          ([before, after]) => before.kind === 'all' && after.kind !== 'all',
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.leaveAllTopics());
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

  private selectArrivedTopic(): void {
    const slug = this.arrivedWithTopic;
    if (slug && this.canOpen(slug)) this.chat.selectTopic(slug);
  }

  private sees(topic: string | null): boolean {
    return this.topics().some((one) => one.slug === topic);
  }

  private canOpen(topic: string): boolean {
    return this.topics().some((one) => one.slug === topic && one.canOpen);
  }

  /** A link's collection first, then "Todos os acervos", then the selected one (KBC-091). */
  private startingScope(): Scope {
    if (this.arrivedWithTopic)
      return { kind: 'topic', slug: this.arrivedWithTopic };
    return this.kept()?.filters.allTopics
      ? { kind: 'all' }
      : { kind: 'selected' };
  }

  private topicInForce(): string | null {
    const scope = this.scope();
    if (scope.kind === 'all') return null;
    if (scope.kind === 'topic' && this.sees(scope.slug)) return scope.slug;
    return this.chat.topicSlug();
  }

  /** The scrolling keys with nothing focused move the library (its own scroller). */
  protected pageKey(event: KeyboardEvent): void {
    scrollPageByKey(this.host, event);
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

  /** The header's ▶: pauses what of this list plays, or plays its first ready media. */
  protected playAll(): void {
    const item = this.playingItem() ?? this.firstPlayable();
    if (item) this.playNow.play(item);
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
    if (change.kind === 'topic') this.chooseCollection(change.topic, filters);
    else this.saveFilters(filters);
    if (change.kind === 'clear') this.focusAfterRender(this.allTitle);
    // The collection's chip went with the focus: during a search, to the results' title.
    else if (change.kind === 'topic' && change.topic === null) {
      const results = this.searchResults();
      if (results) results.focusTitle();
      else this.focusAfterRender(this.allTitle);
    }
  }

  /** Only this replaces the kept collection; choosing one selects it everywhere (KBC-091). */
  private chooseCollection(
    topic: string | null,
    filters: LibraryFilters,
  ): void {
    this.scope.set(topic ? { kind: 'topic', slug: topic } : { kind: 'all' });
    if (topic && this.canOpen(topic)) this.chat.selectTopic(topic);
    this.saveChoice({ ...filters, topic, allTopics: topic === null });
  }

  private leaveAllTopics(): void {
    const kept = this.kept()?.filters;
    if (kept?.allTopics) this.saveChoice({ ...kept, allTopics: false });
  }

  /** Any change but the collection's: what is kept of it stays. */
  private saveFilters(chosen: LibraryFilters): void {
    const kept = this.kept()?.filters;
    this.saveChoice({
      ...chosen,
      topic: kept?.topic ?? null,
      allTopics: kept?.allTopics ?? false,
    });
  }

  private saveChoice(chosen: LibraryFilters): void {
    const subject = chosen.subject ?? this.lostSubject();
    const filters = { ...chosen, subject };
    this.choose({ filters }, { libraryFilters: filters });
  }

  protected clearFilters(): void {
    this.saveFilters(NO_FILTERS);
    this.focusAfterRender(this.allTitle);
  }

  /** The way out of a collection with nothing to show. */
  protected showAllCollections(): void {
    this.changeFilter({ kind: 'topic', topic: null });
    this.focusAfterRender(this.allTitle);
  }

  protected changeSort(sort: LibrarySort): void {
    this.choose({ sort }, { librarySort: sort });
  }

  protected changeView(display: LibraryDisplay): void {
    const view: LibraryView = display === 'compact' ? 'list' : display;
    this.compact.set(display === 'compact');
    keepCompact(display === 'compact');
    if (view !== this.choices()?.view) {
      // Each view opens its recordings anew, as the grid's cards do.
      this.openTracks.set(new Set());
      this.choose({ view }, { libraryView: view });
    }
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

  /* ---------- Header actions (media-library actionBar) ---------- */

  /** 🔀: one ready media of the list, at random (there is no play queue to shuffle). */
  protected playAny(): void {
    const ready = this.items().filter((item) => item.status === 'ready');
    const item = ready[Math.floor(Math.random() * ready.length)];
    if (item) this.playNow.play(item);
  }

  protected headerAction(id: string): void {
    if (id === 'bookmarks') void this.router.navigate(['/midia/marcadores']);
    else if (id === 'select') this.startSelection();
    else if (id === 'select-all')
      this.selected.set(new Set(this.selectable().map((item) => item.id)));
    else if (id === 'clear-recents') this.askClearRecents();
  }

  /** The action bar's 🔍: the search field of the filters' row. */
  protected focusSearch(): void {
    this.searchBox()?.nativeElement.focus();
  }

  /** The phone's 🔍 opens the search row and puts the cursor in it; again, closes it. */
  protected toggleSearch(): void {
    if (this.searchOpen() || this.searching()) {
      this.searchOpen.set(false);
      if (this.query()) this.query.set('');
      return;
    }
    this.searchOpen.set(true);
    this.focusAfterRender(this.searchBox);
  }

  /* ---------- Recents (BR-4) ---------- */

  protected askClearRecents(): void {
    this.confirmingClear.set(true);
    this.focusAfterRender(this.keepRecentsButton);
  }

  /** Back to the link that asked, or to the list when the ⋯ asked (no link in sight). */
  protected cancelClearRecents(): void {
    this.confirmingClear.set(false);
    this.focusAfterRender(this.clearRecentsButton);
  }

  protected clearRecents(): void {
    this.confirmingClear.set(false);
    this.focusAfterRender(this.allTitle);
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

  /** "Selecionar mídias" (header ⋯, a row's ⋯ on a phone): the selection starts with one. */
  protected startSelection(item?: LibraryItem): void {
    const first = item ?? this.selectable()[0];
    if (first) this.select(first, true);
    this.focusAfterRender(this.selectAllBox);
  }

  protected toggleAll(event: Event): void {
    const on = event.target instanceof HTMLInputElement && event.target.checked;
    this.selected.set(
      on ? new Set(this.selectable().map((item) => item.id)) : new Set(),
    );
  }

  protected cancelSelection(): void {
    this.selected.set(new Set());
    // A phone has no table head (media-library@mobile): the list's heading takes the focus.
    this.focusAfterRender(this.phone() ? this.allTitle : this.selectAllBox);
  }

  protected markSelected(played: boolean): void {
    this.mark([...this.selected()], played);
  }

  protected rowAction(item: LibraryItem, action: RowAction): void {
    if (action === 'remove') this.askRemove(item);
    else if (action === 'edit') this.openEdit(item);
    else if (action === 'play') this.play(item);
    else if (action === 'select') this.startSelection(item);
    else if (action === 'select-all') this.headerAction('select-all');
    else if (action === 'play-next') this.playNextOf(item);
    else if (action === 'bookmarks')
      void this.router.navigate(['/midia', item.id], {
        fragment: 'marcadores',
      });
    else if (action === 'retry') this.retry(item);
    else if (action === 'copy-link') this.copyLink(item);
    else this.mark([item.id], action === 'mark-played');
  }

  /** "Tocar em seguida": after the one playing, said aloud (or it plays now). */
  private playNextOf(item: LibraryItem): void {
    if (this.playNow.playNext(item))
      this.announcement.set(
        $localize`:@@library.playsNext:“${item.title}:title:” toca em seguida.`,
      );
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

  /** Sent to a collection out of this list: the audio is there, and this says where. */
  protected uploaded(item: MediaItem): void {
    this.firstPage.reload();
    if (this.isOutOfList(item))
      this.moved.set(sentElsewhereOf(item, this.topics()));
  }

  private isOutOfList({ topic }: MediaItem): boolean {
    const shown = this.choices()?.filters.topic ?? null;
    const parent = this.topics().find((one) => one.slug === topic)?.parent;
    return shown !== null && topic !== shown && parent !== shown;
  }

  /** "Copiar link" (desktop) / "Compartilhar" (phone, the system's sheet when it has one). */
  private copyLink(item: LibraryItem): void {
    const view = this.host.ownerDocument.defaultView;
    const url = new URL(
      this.router.serializeUrl(this.router.createUrlTree(['/midia', item.id])),
      view?.location.origin ?? 'http://localhost',
    ).toString();
    const nav = view?.navigator;
    const done = () =>
      this.announcement.set($localize`:@@library.linkCopied:Link copiado.`);
    const failed = () =>
      this.actionError.set(
        $localize`:@@library.linkFailed:Não consegui copiar o link. Abra a mídia e copie o endereço.`,
      );
    if (this.phone() && nav?.share) {
      nav.share({ title: item.title, url }).catch(() => undefined);
      return;
    }
    if (!nav?.clipboard) {
      failed();
      return;
    }
    nav.clipboard.writeText(url).then(done, failed);
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

/** "<título> foi enviado para o acervo <nome>.", with the way there. */
function sentElsewhereOf(item: MediaItem, topics: readonly Topic[]): MediaMove {
  const name =
    topics.find((topic) => topic.slug === item.topic)?.title ?? item.topic;
  return {
    topic: item.topic,
    text: $localize`:@@media.sentElsewhere:${item.title}:title: foi enviado para o acervo ${name}:topic:.`,
  };
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

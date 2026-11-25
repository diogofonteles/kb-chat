import {
  DOCUMENT,
  DecimalPipe,
  NgComponentOutlet,
  NgTemplateOutlet,
} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  DestroyRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type {
  AnswerSource,
  SearchFilters,
  SearchKind,
  SearchMode,
} from '@kb-chat/contracts';
import { httpResource } from '@angular/common/http';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterOutlet,
} from '@angular/router';
import { Subject, filter, from, map, of, switchMap, take } from 'rxjs';
import { suggestionListSchema } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { suggestionsUrl } from '@core/api/kb-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { DocumentPanel } from '@features/document/document-panel.js';
import { Sidebar, type SidebarAction } from '@features/sidebar/sidebar.js';
import { NO_FILTERS, type ChatMessage } from './chat-message.js';
import { ProcessingQueueStore } from '@features/media/queue/processing-queue-store.js';
import { ChatStore } from './chat-store.js';
import { CollectionHeading } from './collection-heading.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { provideResearchRestorer } from '@features/research/research-restorer.js';
import { Composer } from './composer.js';
import type { OpenedHit } from './result-card.js';
import { describeForAnnouncement } from './result-count.js';
import { ResultMessage, type OpenedPassage } from './result-message.js';
import { passageKey } from './references.js';
import { PassagePanel } from '@features/media/search-hit/passage-panel.js';
import { TrackPassagePanel } from '@features/media/track-passage/track-passage-panel.js';
import type { TrackOpening } from '@features/research/track-opening.js';
import {
  controlAt,
  placeOf,
  type TriggerPlace,
} from '@features/research/trigger-place.js';
import { ResearchStore } from '@features/research/research-store.js';
import {
  ResearchThread,
  type SourceOpening,
} from '@features/research/research-thread.js';
import { ViewStore } from './view-store.js';
import { ScopeBar } from './scope/scope-bar.js';
import { RESEARCH_PROFILES } from '@kb-chat/contracts';
import { PROFILE_COPY } from '@features/research/profile-copy.js';
import { MiniPlayer } from '@features/media/player/mini-player.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { AudioPresence } from '@features/shell/audio-presence.js';
import { BottomNav, navTabs, type NavTab } from '@features/shell/bottom-nav.js';
import { PageHeader } from '@features/shell/page-header.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { TopBar } from '@features/shell/top-bar.js';
import { hasLibrary } from '@features/media/library/library-access.js';
import { UiAvatar } from '@ui/avatar.js';
import { UiIconButton } from '@ui/button.js';
import { coverGradient } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';

/** Where Sua biblioteca's collapsed state is kept (a per-viewer convenience). */
const COLLAPSED_KEY = 'kb-chat.library-collapsed';
import { ConversationHistory } from './home/conversation-history.js';
import { ConversationHome } from './home/conversation-home.js';

const DESKTOP_QUERY = '(min-width: 1024px)';

/** The media pages: the list and player (T14, T15) and the library (T16, KBC-051). */
/** A page that renders in place of the conversation: media pages and T24 (KBC-103). */
const isSettingsUrl = (url: string): boolean =>
  /^\/configuracoes(\/|\?|#|$)/.test(url);

const isMediaUrl = (url: string): boolean =>
  /^\/(midia|biblioteca|fila|adicionar|acervos|configuracoes|catalogo-ui)(\/|\?|#|$)/.test(
    url,
  );

/**
 * "Preparar áudio", the tracks editor and the bounds (KBC-130): a guided flow with its own
 * head, so the main panel shows no collection header; on a phone it takes the whole screen.
 */
const isGuidedFlowPath = (path: string): boolean =>
  /^\/midia\/[^/]+\/(preparar|faixas|limites)$/.test(path);

/**
 * Chat page (screens.md): two views over one question box and document panel, the free
 * search engine and the research agent (KBC-008), each with its own conversation.
 */
@Component({
  selector: 'app-chat-page',
  imports: [
    Composer,
    ResultMessage,
    ResearchThread,
    ScopeBar,
    DocumentPanel,
    PassagePanel,
    TrackPassagePanel,
    Sidebar,
    DecimalPipe,
    RouterOutlet,
    MiniPlayer,
    TopBar,
    BottomNav,
    NgComponentOutlet,
    NgTemplateOutlet,
    RouterLink,
    UiAvatar,
    UiIcon,
    UiIconButton,
    ConversationHistory,
    ConversationHome,
  ],
  providers: [
    ChatStore,
    ViewStore,
    ResearchStore,
    AudioPresence,
    provideResearchRestorer(RESEARCH_RESTORER),
  ],
  templateUrl: './chat-page.html',
  styleUrl: './chat-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'shortcut($event)' },
})
export class ChatPage {
  protected readonly store = inject(ChatStore);
  protected readonly views = inject(ViewStore);
  protected readonly research = inject(ResearchStore);
  private readonly session = inject(SessionStore);
  /** A member sees only the collections a master granted (KBC-010). */
  protected readonly guest = computed(
    () => this.session.me()?.role === 'member',
  );
  /** Transcriptions not yet documents, with "Publicar" (KBC-114 FR-6): masters only. */
  protected readonly master = this.session.isMaster;
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  /** Absent on the media pages (/midia), which render in place of the conversation. */
  private readonly composer = viewChild(Composer);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly drawer = viewChild<ElementRef<HTMLDialogElement>>('drawer');
  private readonly menuButton =
    viewChild<ElementRef<HTMLButtonElement>>('menuButton');

  /** Desktop shows the side panel as a column; phones open it as a drawer (KBC-005 FR-6). */
  protected readonly desktop = signal(this.matchesDesktop());

  private readonly collectionHeading = inject(CollectionHeading);
  /** A page with its own header (the library, a collection's album page): see PageHeader. */
  protected readonly ownHeader = inject(PageHeader).current;
  /** Spoken from here: the page and the sidebar come and go, the layout stays. */
  protected readonly queue = inject(ProcessingQueueStore);
  /** The v2 audio rule (KBC-125 BR-2). */
  protected readonly audio = inject(AudioPresence);
  /** The shell's optional right panel, for the areas (KBC-125 FR-1). */
  protected readonly rightPanel = inject(RightPanel);
  /** A routed page's colour under the phone's header row (v2 · celular). */
  protected readonly pageChrome = inject(PageHeader);
  protected readonly me = this.session.me;
  private readonly topBar = viewChild(TopBar);
  /** The main panel's header (title, view switch): floating notices start under it. */
  private readonly pageHeader =
    viewChild<ElementRef<HTMLElement>>('pageHeader');
  private readonly shellFoot = viewChild<ElementRef<HTMLElement>>('shellFoot');
  protected readonly engineSource = inject(MediaEngine).source;
  /** The address without query or fragment, as the router last settled on it. */
  private readonly path = toSignal(
    inject(Router).events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.split(/[?#]/)[0] ?? ''),
    ),
    { initialValue: inject(Router).url.split(/[?#]/)[0] ?? '' },
  );
  /**
   * The page's name on a phone's header row (v2 · celular: the avatar, then "Biblioteca",
   * "Fila de processamento"…): the routed page's title without the app's name.
   */
  protected readonly pageName = computed(() => {
    this.path();
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    const title = route.title ?? '';
    return title.split(' — ')[0]?.trim() ?? '';
  });
  /** Sua biblioteca collapsed to its covers (desktop, FR-1). */
  protected readonly collapsed = signal(this.readCollapsed());
  /** Sua biblioteca over the main panel ("Biblioteca expandida", ⤢), until an item opens. */
  protected readonly expanded = signal(false);
  /** The media library's page, for who has it (Biblioteca, else Mídia). */
  protected readonly libraryPath = computed(() => {
    if (hasLibrary(this.session)) return '/biblioteca';
    return this.audio.listens() && this.store.topicSlug() !== null
      ? '/midia'
      : null;
  });
  /** The phone tabs under the audio rule (BR-2). */
  protected readonly navTabs = computed(() =>
    navTabs(
      this.audio.shown()
        ? { queue: this.queue.allowed(), library: this.libraryPath() }
        : null,
    ),
  );
  /**
   * A phone's tab: Conversas on the home opens the conversation list (chat-history@mobile),
   * Buscar keeps its tab on while the search view waits for a question.
   */
  protected readonly phoneTab = signal<'history' | 'search' | null>(null);
  protected readonly phoneHistory = computed(
    () =>
      this.phoneTab() === 'history' &&
      this.isEmpty() &&
      !this.desktop() &&
      !this.onMedia(),
  );
  protected readonly navActive = computed((): NavTab | null => {
    if (this.onMedia() || this.phoneHistory()) return null;
    const searching = this.currentView() === 'search';
    return searching && (!this.isEmpty() || this.phoneTab() === 'search')
      ? 'search'
      : null;
  });
  /** The main panel's gradient: the colour of the collection's cover (v2 pageHeader tint). */
  protected readonly tint = computed(() => {
    if (!this.onMedia() && this.researching()) return 'var(--tint-research)';
    if (!this.onMedia() && this.searchPage()) return 'var(--tint-search)';
    const title = this.topic()?.title;
    return title ? coverGradient(title)[0] : null;
  });
  /**
   * The player bar row (FR-3): with audio (BR-2), except on the page of what plays, where the
   * full player shows it.
   */
  protected readonly playerShown = computed(() => {
    if (!this.audio.shown()) return false;
    const source = this.engineSource();
    if (!source || this.desktop()) return true;
    return this.path() !== `/midia/${encodeURIComponent(source.id)}`;
  });
  /**
   * The pages with a header of their own (v2 · Mídia — Player, Fila e Marcadores): the
   * player names the collection ("Áudio · Alquimia Prática"), "Meus marcadores" and the
   * Fila are lists of every collection, "Adicionar conteúdo" chooses its own (KBC-184), so
   * the shell's collection title stays out.
   */
  protected readonly playerPage = computed(() =>
    /^\/(midia\/[^/]+|fila|adicionar)$/.test(this.path()),
  );
  /**
   * On a phone the page of what plays is the full-screen player (KBC-129 FR-2, v2 · Mídia —
   * Player, celular): no navigation under it; its own "← Biblioteca" leads back.
   */
  protected readonly fullScreenPlayer = computed(() => {
    const source = this.engineSource();
    return (
      !this.desktop() &&
      source !== null &&
      this.path() === `/midia/${encodeURIComponent(source.id)}`
    );
  });
  /** The guided flow of KBC-130 (v2 · Mídia — Preparar, Faixas e Limites). */
  protected readonly guidedFlow = computed(() => isGuidedFlowPath(this.path()));
  /** On a phone the guided flow covers the screen: no navigation and no mini player under it. */
  protected readonly phoneFlow = computed(
    () => !this.desktop() && this.guidedFlow(),
  );
  /** The collection in the header: on a media page, the one that page shows (KBC-091). */
  protected readonly topic = computed(() => {
    if (!this.onMedia()) return this.store.topic();
    const scope = this.collectionHeading.scope();
    if (scope?.kind !== 'topic') return null;
    return this.store.topicList().find((t) => t.slug === scope.slug) ?? null;
  });
  protected readonly allCollections = computed(
    () => this.onMedia() && this.collectionHeading.scope()?.kind === 'all',
  );
  protected readonly topicList = this.store.topicList;
  /** The chosen collection (with its sub-collections) has no text yet (KBC-048, ADR 0028). */
  protected readonly emptyTopic = computed(
    () => this.store.topic()?.documentCount === 0,
  );
  protected readonly messages = this.store.messages;
  protected readonly opened = this.store.openDocument;
  /** The source of an AI answer open in the panel: marked in its answer. */
  protected readonly openSourceId = computed(() => {
    const open = this.opened();
    return open?.sources ? open.id : null;
  });
  protected readonly currentView = this.views.current;
  protected readonly researching = computed(
    () => this.currentView() === 'research',
  );
  protected readonly isEmpty = computed(() =>
    this.researching()
      ? this.research.turns().length === 0
      : this.messages().length === 0,
  );
  /** Search results are a page in the main panel, wider than the reading column (KBC-126). */
  protected readonly searchPage = computed(
    () => !this.researching() && !this.isEmpty(),
  );
  /** The scope row (escopo): desktop everywhere but a search page; a phone on the home. */
  protected readonly showScope = computed(() => {
    if (this.onMedia()) return false;
    if (this.desktop()) return !this.searchPage();
    // (with no collection too: chat-no-topics@mobile keeps the chips over its empty state)
    return this.isEmpty() && !this.researching() && !this.phoneHistory();
  });
  /** A phone's research home: the profiles at the top (cmHome, mode 'ia'). */
  protected readonly showProfiles = computed(
    () =>
      !this.desktop() &&
      !this.onMedia() &&
      this.researching() &&
      this.isEmpty() &&
      !this.noTopics() &&
      !this.phoneHistory(),
  );
  protected readonly profileOptions = RESEARCH_PROFILES.map((value) => ({
    value,
    label: PROFILE_COPY[value].label(),
  }));
  protected readonly exhaustiveHelp = PROFILE_COPY.exhaustive.help();
  /** The phone's search pill shows the search on screen (cmResults); null elsewhere. */
  protected readonly pillQuestion = computed(() =>
    !this.desktop() && this.searchPage()
      ? (this.messages().at(-1)?.question ?? null)
      : null,
  );
  /** The desktop top bar's field holds the search on screen (chat-results). */
  protected readonly topQuery = computed(() =>
    this.desktop() && this.searchPage()
      ? (this.messages().at(-1)?.question ?? '')
      : '',
  );
  /** The phone's page name (cmHead): Conversas, Buscar or Pesquisa com IA. */
  protected readonly pageTitle = computed(() => {
    if (this.phoneHistory())
      return $localize`:@@page.titleConversations:Conversas`;
    if (this.researching())
      return $localize`:@@page.titleResearch:Pesquisa com IA`;
    if (this.searchPage()) return $localize`:@@page.titleSearch:Buscar`;
    return $localize`:@@page.titleConversations:Conversas`;
  });
  /** On phones the panel covers the conversation: make it inert so Tab stays in the panel. */
  private readonly router = inject(Router);
  /** The questions typed in the top bar's search, in order. */
  private readonly globalSearches = new Subject<string>();
  /** /midia and /midia/:id render in this layout instead of the conversation (T14, T15). */
  protected readonly onMedia = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => isMediaUrl(this.router.url)),
    ),
    { initialValue: isMediaUrl(this.router.url) },
  );
  /**
   * Configurações is a page with its own title and, on a phone, pushed screens with their
   * own "‹" (v2 · Configurações): no shell title row over it, no tab bar under it.
   */
  protected readonly onSettings = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => isSettingsUrl(this.router.url)),
    ),
    { initialValue: isSettingsUrl(this.router.url) },
  );
  /** The document panel belongs to the conversation: hidden on the media pages. */
  protected readonly panel = computed(() =>
    this.onMedia() ? null : this.opened(),
  );
  /**
   * A document opened from the search, on desktop: the document page takes the main panel
   * and its "Sobre este documento" the right one (chat-document); a source of an answer
   * stays the 460 panel beside it (Telas-chave, research with the source open).
   */
  protected readonly docPage = computed(() => {
    const doc = this.panel();
    return (
      this.desktop() &&
      doc !== null &&
      !doc.sources?.length &&
      this.rightPanel.content() === null
    );
  });
  /** A spoken passage in the reading panel instead of a document (KBC-039 FR-6). */
  protected readonly passage = computed(() =>
    this.onMedia() ? null : (this.store.openPassage()?.hit ?? null),
  );
  /** A cited track on its passage, with the player beside it (KBC-099, T22). */
  protected readonly track = computed(() =>
    this.onMedia() ? null : this.store.openTrack(),
  );
  /**
   * What opened the track panel, and its place in the conversation: the focus goes back
   * there when it closes (AC-12), also when the answer was drawn anew meanwhile (QA BUG-2).
   */
  private trackTrigger: HTMLElement | null = null;
  private triggerPlace: TriggerPlace | null = null;
  protected readonly activePassage = computed(() => {
    const hit = this.passage();
    return hit ? passageKey(hit) : null;
  });
  /** A spoken passage's full player shows this media: no mini-player for it meanwhile. */
  protected readonly playerInPanel = computed(
    () => this.passage()?.mediaId ?? null,
  );
  protected readonly panelOpen = computed(
    () =>
      this.panel() !== null || this.passage() !== null || this.track() !== null,
  );
  protected readonly covered = computed(
    () => this.panelOpen() && !this.desktop(),
  );
  /** The largest subjects as one-click starting points (KBC-006 FR-1); hidden when unavailable. */
  private readonly suggestionList = httpResource(
    () => {
      const slug = this.store.topicSlug();
      return slug ? suggestionsUrl(slug) : undefined;
    },
    { parse: (body) => suggestionListSchema.parse(body) },
  );
  protected readonly suggestions = computed(() =>
    this.suggestionList.hasValue() ? this.suggestionList.value().items : [],
  );
  protected readonly topicNotice = computed(() => {
    const slug = this.store.topicNotice();
    const topic = this.store.topicList().find((t) => t.slug === slug);
    return topic
      ? $localize`:@@page.newInTopic:Nova conversa em ${topic.title}:topic:`
      : '';
  });
  protected readonly topicsError = computed(() => {
    const err = this.store.topics.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly noTopics = computed(
    () => this.store.topics.hasValue() && this.store.topicList().length === 0,
  );
  /** Short live-region text (the cards themselves are not announced). */
  protected readonly announcement = computed(() => {
    const last = this.researching() ? undefined : this.messages().at(-1);
    if (!last || last.status === 'loading') return '';
    // Prefixed with the question so a repeated identical count is still announced.
    const outcome = last.response
      ? describeForAnnouncement(last.response)
      : errorMessage(last.error ?? 'INTERNAL');
    return `${last.question}: ${outcome}`;
  });

  /**
   * Enter in the global search (FR-2). From a page in the conversation's place it asks once
   * the conversation is back, so what the leaving page does to the collection in use lands
   * before the question, not over it; and it waits for the collection in use to be known
   * (the search can be typed before the list of collections arrives). A newer search
   * replaces one still waiting.
   */
  private askGlobalSearches(): void {
    const collectionKnown = toObservable(this.store.topicSlug).pipe(
      filter((slug) => slug !== null),
      take(1),
    );
    this.globalSearches
      .pipe(
        switchMap((query) =>
          (this.onMedia()
            ? from(this.router.navigateByUrl('/'))
            : of(true)
          ).pipe(
            filter((moved) => moved),
            switchMap(() => collectionKnown),
            map(() => query),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((query) => this.store.ask(query));
  }

  private matchesDesktop(): boolean {
    return this.view?.matchMedia?.(DESKTOP_QUERY).matches ?? true;
  }

  constructor() {
    this.askGlobalSearches();
    const query = this.view?.matchMedia?.(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      const drawer = this.drawer()?.nativeElement;
      this.desktop.set(event.matches);
      // Grown to desktop with the drawer open: it goes away with the Menu button, so focus moves on.
      if (event.matches && drawer?.open) {
        drawer.close();
        afterNextRender(() => this.composer()?.focus(), {
          injector: this.injector,
        });
      }
    };
    query?.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() =>
      query?.removeEventListener('change', onChange),
    );
    // The question box starts focused on desktop; on phones it would pop the keyboard.
    afterNextRender(() => {
      if (this.view?.matchMedia?.(DESKTOP_QUERY).matches)
        this.composer()?.focus();
    });
    // Back from a media page, what was pressed left with it: the focus stays in the page.
    let wasOnMedia = this.onMedia();
    afterRenderEffect(() => {
      const onMedia = this.onMedia();
      if (wasOnMedia && !onMedia && this.desktop()) this.composer()?.focus();
      wasOnMedia = onMedia;
    });
    this.keepFloatTop();
    this.keepFootHeight();
  }

  /**
   * `--shell-foot-h`: how tall the phone's foot (mini player and navigation) is. A media page
   * runs under it, as v2 draws it (media-library@mobile), and ends that much lower, so its
   * last row still scrolls above the foot (FR-4, AC-5).
   */
  private keepFootHeight(): void {
    const root = inject(DOCUMENT).documentElement;
    let observer: ResizeObserver | null = null;
    afterRenderEffect(() => {
      const foot = this.shellFoot()?.nativeElement;
      observer?.disconnect();
      if (!foot || typeof ResizeObserver === 'undefined') return;
      const measure = (): void =>
        root.style.setProperty('--shell-foot-h', `${foot.offsetHeight}px`);
      observer = new ResizeObserver(measure);
      observer.observe(foot);
      measure();
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      root.style.removeProperty('--shell-foot-h');
    });
  }

  /**
   * `--float-top`: where a floating notice (the new-version notice, KBC-123) starts, the
   * bottom edge of the main panel's header as it really is: in the v2 shell it sits under
   * the top bar on desktop and wraps to two rows on narrow phones.
   */
  private keepFloatTop(): void {
    const root = inject(DOCUMENT).documentElement;
    let observer: ResizeObserver | null = null;
    const measure = (): void => {
      const header = this.pageHeader()?.nativeElement;
      if (header)
        root.style.setProperty(
          '--float-top',
          `${Math.round(header.getBoundingClientRect().bottom)}px`,
        );
    };
    afterRenderEffect(() => {
      const header = this.pageHeader()?.nativeElement;
      observer?.disconnect();
      if (!header || typeof ResizeObserver === 'undefined') return;
      observer = new ResizeObserver(measure);
      observer.observe(header);
      measure();
    });
    this.view?.addEventListener('resize', measure);
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      this.view?.removeEventListener('resize', measure);
      root.style.removeProperty('--float-top');
    });
  }

  protected openMenu(): void {
    this.drawer()?.nativeElement.showModal();
  }

  /** Where focus goes when the drawer finishes closing. */
  private focusAfterMenu: 'menu' | 'composer' = 'menu';

  protected closeMenu(): void {
    this.drawer()?.nativeElement.close();
  }

  /**
   * The drawer's `close` event arrives after the action that closed it, so it decides where
   * focus goes: the question box after an action that needs typing, else the Menu button.
   */
  protected menuClosed(): void {
    const target = this.focusAfterMenu;
    this.focusAfterMenu = 'menu';
    if (target === 'composer') this.composer()?.focus();
    else this.menuButton()?.nativeElement.focus();
  }

  /** A tap on the backdrop lands on the <dialog> itself, outside its content. */
  protected drawerClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeMenu();
  }

  protected sidebarActed(action: SidebarAction): void {
    // What opens from "Biblioteca expandida" shows in the main panel again.
    this.expanded.set(false);
    // A conversation started or restored from the media pages shows the conversation.
    if (
      (action === 'new' || action === 'restore' || action === 'document') &&
      this.onMedia()
    )
      void this.router.navigateByUrl('/');
    // A new conversation (or another collection) is ready to type into.
    const typing = action === 'new' || (action === 'topic' && !this.onMedia());
    if (this.drawer()?.nativeElement.open) {
      this.focusAfterMenu = typing ? 'composer' : 'menu';
      this.closeMenu();
    } else if (typing) {
      afterNextRender(() => this.composer()?.focus(), {
        injector: this.injector,
      });
    }
  }

  protected changeMode(mode: SearchMode): void {
    this.store.setMode(mode);
  }

  /** Arrows in the phone's profile chips move the choice, as in a radio group. */
  protected moveProfile(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const values = this.profileOptions.map((option) => option.value);
    const at = values.indexOf(this.research.profile());
    const next = values[(at + step + values.length) % values.length];
    if (!next) return;
    this.research.chooseProfile(next);
    const group = (event.currentTarget as HTMLElement | null)?.parentElement;
    afterNextRender(
      () =>
        group
          ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
          ?.focus(),
      { injector: this.injector },
    );
  }

  /**
   * "+" of the phone's header (KBC-164 FR-1): a new conversation in the view on screen, the
   * other view keeping its own; from the conversation list, back to the home to type into.
   */
  protected startNewConversation(): void {
    if (this.researching()) this.research.newConversation();
    else this.store.newConversation();
    this.phoneTab.set(null);
    this.sidebarActed('new');
  }

  protected ask(question: string): void {
    if (this.phoneTab() === 'history') this.phoneTab.set(null);
    if (this.researching()) this.askResearch(question);
    else this.store.ask(question);
  }

  /** The new question scrolls into view; focus stays in the question box, as in a chat. */
  private askResearch(question: string): void {
    this.research.ask(question);
    afterNextRender(
      () =>
        this.host
          .querySelector('app-research-message:last-of-type')
          ?.scrollIntoView({ block: 'start' }),
      { injector: this.injector },
    );
  }

  /**
   * A suggestion searches the subject's name with the subject filter on (KBC-006 FR-2); in
   * the research view it becomes a question to the agent.
   */
  protected askAbout(concept: string): void {
    if (this.researching()) {
      this.askResearch(
        $localize`:@@research.aboutSubject:O que o acervo diz sobre ${concept}:subject:?`,
      );
      return;
    }
    this.store.ask(concept, {
      filters: { ...NO_FILTERS, concepts: [concept] },
      origin: 'suggestion',
    });
  }

  /**
   * A cited source opens in the document panel beside the answer, on the answer's words,
   * with the answer's other sources at hand (KBC-127 FR-1).
   */
  protected openSource({ doc, question, sources }: SourceOpening): void {
    const topic = this.store.topicSlug();
    if (topic) this.store.openSource(topic, doc, { question, sources });
  }

  /**
   * "Perguntar à IA" on a document (KBC-127): the research view, with a question about it
   * ready in the box to finish and send (nothing is asked, nor spent, before that).
   */
  protected askAiAbout(title: string): void {
    this.views.select('research');
    this.closeDocument();
    afterNextRender(
      () =>
        this.composer()?.fill(
          $localize`:@@research.aboutDocument:O que “${title}:title:” diz sobre `,
        ),
      { injector: this.injector },
    );
  }

  /** A cited track opens on its passage, paused, in the reading panel (KBC-099 FR-8). */
  protected openTrack({
    source,
    at,
    trigger,
    sources,
    question,
  }: TrackOpening): void {
    this.trackTrigger = trigger;
    this.triggerPlace = placeOf(trigger, this.host);
    this.store.openTrackPassage({
      source,
      at,
      ...(sources ? { sources } : {}),
      ...(question === undefined ? {} : { question }),
    });
  }

  /**
   * ‹ › on the audio source (KBC-150): another source of the same answer in the same place, a
   * track on its first cited passage, a text in the document panel with the answer's texts.
   */
  protected chooseSource(source: AnswerSource): void {
    const open = this.track();
    const sources = open?.sources ?? [];
    const question = open?.question ?? '';
    if (source.media) {
      this.store.openTrackPassage({
        source,
        at: source.passages?.[0]?.at ?? '',
        sources,
        question,
      });
      return;
    }
    const topic = this.store.topicSlug();
    if (!topic) return;
    this.store.openSource(
      topic,
      { id: source.id, title: source.title },
      {
        question,
        sources: sources
          .filter((one) => !one.media)
          .map(({ n, id, title }) => ({ n, id, title })),
      },
    );
  }

  /** "Parar" disappears with the answer in flight: focus moves to the question box. */
  protected stopResearch(): void {
    this.research.stop();
    afterNextRender(() => this.composer()?.focus(), {
      injector: this.injector,
    });
  }

  /** A hit opens in its own collection: a sub-collection when searching the parent. */
  protected openHit(hit: OpenedHit, message: ChatMessage): void {
    this.store.open(hit.topic, { id: hit.id, title: hit.title }, message);
  }

  /** A spoken passage opens in the reading panel and plays (KBC-039 FR-6). */
  protected openPassage(opened: OpenedPassage, message: ChatMessage): void {
    this.store.openMedia(opened.hit, {
      messageId: message.id,
      position: opened.position,
    });
  }

  /** "Buscar em" on a message: remembered, and the message runs again (BR-4). */
  protected chooseKinds(message: ChatMessage, kinds: SearchKind[]): void {
    this.store.chooseKinds(message, kinds);
  }

  /** A subject chip in the panel filters the message that opened it (KBC-003 FR-5). */
  protected filterByConcept(concept: string): void {
    const message = this.messages().find(
      (m) => m.id === this.opened()?.messageId,
    );
    if (!message || message.filters.concepts.includes(concept)) return;
    this.store.refine(message, {
      ...message.filters,
      concepts: [...message.filters.concepts, concept],
    });
  }

  protected refine(message: ChatMessage, filters: SearchFilters): void {
    this.store.refine(message, filters);
  }

  protected loadMore(message: ChatMessage): void {
    this.store.loadMore(message);
  }

  protected retry(message: ChatMessage): void {
    this.store.retry(message);
  }

  protected askAgainIn(message: ChatMessage, mode: SearchMode): void {
    this.store.setMode(mode);
    this.store.ask(message.question, {
      mode,
      filters: message.filters,
      origin: 'mode',
    });
  }

  /** It left the collection (KBC-187): nothing to read, and one document less. */
  protected documentRemoved(): void {
    this.closeDocument();
    this.store.topics.reload();
  }

  protected titleOf(topic: string): string {
    return (
      this.store.topicList().find((one) => one.slug === topic)?.title ?? ''
    );
  }

  protected closeDocument(): void {
    const closedId = this.opened()?.id;
    const track = this.track() !== null;
    const trigger = this.trackTrigger;
    const place = this.triggerPlace;
    this.trackTrigger = null;
    this.triggerPlace = null;
    this.store.close();
    if (track && (trigger || place)) {
      // Back to the citation or chip that opened the track (AC-12), once it is visible again:
      // the same node, or the one now at its place if the answer was drawn anew (QA BUG-2).
      afterNextRender(
        () => {
          const back = trigger?.isConnected
            ? trigger
            : controlAt(place, this.host);
          if (back) back.focus();
          else this.composer()?.focus();
        },
        { injector: this.injector },
      );
      return;
    }
    // Back to the card that opened the document (focusing the question box would pop the
    // phone keyboard); runs after the conversation is visible again so focus never lands on <body>.
    afterNextRender(() => this.focusCard(closedId), {
      injector: this.injector,
    });
  }

  private focusCard(id: string | undefined): void {
    const cards = this.host.querySelectorAll<HTMLElement>('[data-doc-id]');
    const card = [...cards].find((element) => element.dataset['docId'] === id);
    if (card) card.focus();
    else this.composer()?.focus();
  }

  protected reloadTopics(): void {
    this.store.topics.reload();
  }

  /** The page's keys: "/" for the question box, ⌘K / Ctrl K for the global search. */
  protected shortcut(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')
      this.focusGlobalSearch(event);
    else this.focusOnSlash(event);
  }

  /**
   * ⌘K / Ctrl K focuses the global search from anywhere (KBC-125 FR-2, AC-2), except while
   * typing in a field, which keeps the key. On a phone it is "Buscar".
   */
  private focusGlobalSearch(event: KeyboardEvent): void {
    if (isTyping(event.target)) return;
    event.preventDefault();
    const bar = this.topBar();
    if (bar) bar.focusSearch();
    else this.navChosen('search');
  }

  /**
   * "/" focuses the question box. Pressed in the box while it is still empty (it has focus
   * on load), it does nothing, so following the hint never types "/" (M-9); in any other
   * field it types as usual.
   */
  private focusOnSlash(event: KeyboardEvent): void {
    if (event.key !== '/') return;
    if (this.composer()?.isEmptyField(event.target)) {
      event.preventDefault();
      return;
    }
    if (isTyping(event.target)) return;
    event.preventDefault();
    const composer = this.composer();
    // A desktop search page asks in the top bar's field (it has no question box).
    if (composer) composer.focus();
    else this.topBar()?.focusSearch();
  }

  /** Enter in the global search: the free search of the collection in use (FR-2). */
  protected globalSearch(query: string): void {
    this.expanded.set(false);
    this.views.select('search');
    this.globalSearches.next(query);
  }

  /** ✦ in the top bar: the research view, ready to type into. */
  protected openResearch(): void {
    this.expanded.set(false);
    if (this.views.researchAvailable()) this.views.select('research');
    this.showConversation();
  }

  protected goHome(): void {
    this.expanded.set(false);
    this.showConversation();
  }

  /** A phone tab that acts instead of opening a page (Buscar, Acervos). */
  protected navChosen(tab: NavTab): void {
    if (tab === 'collections') this.openMenu();
    else if (tab === 'conversations') {
      // On the home Conversas lists the conversations, and from the list leads home again.
      if (this.phoneHistory()) this.phoneTab.set(null);
      else if (this.isEmpty() && !this.onMedia()) this.phoneTab.set('history');
      // From a search page, Conversas is the AI research and its own conversation (the
      // phone has no scope chips there: the v1 view switch's way back, KBC-008 AC-5).
      else if (this.searchPage() && this.views.researchAvailable())
        this.views.select('research');
    } else if (tab === 'search') {
      this.phoneTab.set('search');
      this.views.select('search');
      this.showConversation();
    } else this.phoneTab.set(null);
  }

  protected toggleCollapsed(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    try {
      this.view?.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  }

  private readCollapsed(): boolean {
    try {
      return this.view?.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** The conversation on screen, its question box focused. */
  private showConversation(): void {
    if (this.onMedia()) void this.router.navigateByUrl('/');
    afterNextRender(() => this.composer()?.focus(), {
      injector: this.injector,
    });
  }
}

/** A key pressed while typing in a field belongs to the field. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable]') !== null
  );
}

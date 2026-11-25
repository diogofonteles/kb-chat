import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';
import { DOCUMENT, NgTemplateOutlet, formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import type {
  Conversation,
  ConversationKind,
  ConversationStatus,
  ConversationSummary,
  Topic,
} from '@kb-chat/contracts';
import { CollectionDialog } from '@features/collections/collection-dialog.js';
import { UnassignedNotice } from '@features/collections/unassigned-notice.js';
import { HistoryStore } from '@core/history/history-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { EMPTY, Subject, catchError, filter, map, switchMap } from 'rxjs';
import { SpendStore } from '@core/spend/spend-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { ResearchStore } from '@features/research/research-store.js';
import { AccessRequestsStore } from '@core/auth/access-requests-store.js';
import { SettingsButton } from '@features/settings/settings-button.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  ALL_COLLECTIONS_PARAM,
  ALL_COLLECTIONS_VALUE,
  hasLibrary,
} from '@features/media/library/library-access.js';
import { ProcessingQueueStore } from '@features/media/queue/processing-queue-store.js';
import { AudioPresence } from '@features/shell/audio-presence.js';
import { LibraryRecents } from '@features/shell/library-recents.js';
import { LibraryCounts } from './library-counts.js';
import { SignOut } from '@features/shell/sign-out.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { ClosePlayer } from '@features/media/player/close-player.js';
import { NowPlayingPanel } from '@features/media/player/now-playing-panel.js';
import { UiAvatar } from '@ui/avatar.js';
import { UiButton, UiChip, UiIconButton } from '@ui/button.js';
import { UiCover } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import { UiLibraryItem } from '@ui/library-item.js';
import { UiMenu, UiMenuItem } from '@ui/menu.js';
import { DocumentUploadDialog } from '@features/document-upload/document-upload-dialog.js';
import { UiProgress } from '@ui/progress.js';
import {
  collectionTree,
  groupByRecency,
  inVisibleCollections,
  orderByTitle,
  orderCollections,
  savedWhen,
  shows,
  type RecencyGroup,
  type LibraryKind,
  type LibraryOrder,
  type LibraryView,
} from './library-list.js';

export type SidebarAction =
  'new' | 'restore' | 'topic' | 'media' | 'levels' | 'document' | 'player';

/** How a conversation stands, in words (KBC-029): never color alone. */
const STATUS_LABELS: Record<ConversationStatus, () => string> = {
  pending: () => $localize`:@@sidebar.statusPending:pesquisando…`,
  interrupted: () => $localize`:@@sidebar.statusInterrupted:interrompida`,
  failed: () => $localize`:@@sidebar.statusFailed:falhou`,
};

const KIND_LABELS: Record<ConversationKind, () => string> = {
  search: () => $localize`:@@sidebar.kindConversation:Conversa`,
  research: () => $localize`:@@sidebar.kindResearch:Pesquisa com IA`,
};
/** The kind as the wide list's Tipo and the phone Menu's line say it (v2 · Menu lateral). */
const FLAT_KIND_LABELS: Record<ConversationKind, () => string> = {
  search: () => $localize`:@@sidebar.kindSearch:Busca`,
  research: () => $localize`:@@sidebar.kindResearch:Pesquisa com IA`,
};

const CHIPS: readonly { kind: LibraryKind; label: () => string }[] = [
  {
    kind: 'collections',
    label: () => $localize`:@@library.chipCollections:Acervos`,
  },
  { kind: 'audio', label: () => $localize`:@@library.chipAudio:Áudios` },
  {
    kind: 'conversations',
    label: () => $localize`:@@library.chipConversations:Conversas`,
  },
  {
    kind: 'documents',
    label: () => $localize`:@@library.chipDocuments:Documentos`,
  },
];

/** The sections of the list (D5), each with its own heading, count and caret. */
export type LibrarySection =
  'pinned' | 'collections' | 'conversations' | 'documents';

/** Which sections and sub-collection branches the viewer folded (a per-viewer convenience). */
const FOLDED_KEY = 'kb-chat.library-folded';

const RECENCY_LABELS: Record<RecencyGroup, () => string> = {
  today: () => $localize`:@@library.today:Hoje`,
  week: () => $localize`:@@library.lastWeek:Últimos 7 dias`,
  older: () => $localize`:@@library.older:Mais antigas`,
};

/** A pinned media item of the list (Biblioteca, Meus marcadores, Fila de processamento). */
interface PinnedItem {
  readonly key: string;
  readonly title: string;
  readonly meta: string;
  readonly path: string;
  /**
   * Biblioteca only: whether it is the current row, said by the library's scope rather than
   * the path (see `libraryCurrent`).
   */
  readonly current?: boolean;
  readonly icon: 'library' | 'bookmarkFill' | 'upload';
  readonly colors: readonly [string, string];
}

/**
 * "Sua biblioteca" (v2 shell, KBC-125): "+ Nova conversa", the chips, its own search and "Recentes",
 * then sections that never mix (D5): "Fixados" (the pinned media items, audio rule BR-2),
 * "Acervos" (the v1 collection selector, BR-4, as a tree with carets), "Conversas" (the v1
 * history, compact rows grouped by recency) and, on its chip, "Documentos"; each with its own
 * heading, count and caret. At the foot, the day's AI spend. As the phone's "Menu" it
 * also carries the account and what the desktop has in the avatar menu.
 * A container of the chat page: it works on the page-scoped ChatStore.
 */
@Component({
  selector: 'app-sidebar',
  imports: [
    NgTemplateOutlet,
    SettingsButton,
    RouterLink,
    RouterLinkActive,
    CollectionDialog,
    DocumentUploadDialog,
    UnassignedNotice,
    UiAvatar,
    UiButton,
    UiChip,
    UiCover,
    UiIcon,
    UiIconButton,
    UiLibraryItem,
    UiMenu,
    UiMenuItem,
    UiProgress,
  ],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.collapsed]': 'collapsed()',
    '[class.mobile]': 'mobile()',
    '[class.expanded]': 'expanded()',
  },
})
export class Sidebar {
  protected readonly chat = inject(ChatStore);
  private readonly views = inject(ViewStore);
  private readonly research = inject(ResearchStore);
  protected readonly history = inject(HistoryStore);
  protected readonly spend = inject(SpendStore);
  protected readonly session = inject(SessionStore);
  /** The count of "Pessoas e permissões" (masters, KBC-014). */
  protected readonly requests = inject(AccessRequestsStore);
  /** "Fila de processamento" (KBC-090), with a count while anything runs. */
  protected readonly queue = inject(ProcessingQueueStore);
  protected readonly audio = inject(AudioPresence);
  private readonly recents = inject(LibraryRecents);
  private readonly counts = inject(LibraryCounts);
  private readonly settings = inject(SettingsStore);
  private readonly signOutAction = inject(SignOut);
  private readonly closer = inject(ClosePlayer);
  private readonly rightPanel = inject(RightPanel);
  /** What the player has loaded: the phone Menu offers "Fechar o player" then. */
  protected readonly playing = inject(MediaEngine).source;
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  /** Research conversations go to the research view (KBC-008 FR-6), shown as saved. */
  private readonly restorer = inject(RESEARCH_RESTORER);
  /** A newer click cancels the load of the previous one. */
  private readonly opens = new Subject<string>();

  /** The phone's "Menu": the account and the avatar menu's entries come along. */
  readonly mobile = input(false);
  /** Collapsed to its covers (desktop, FR-1). */
  readonly collapsed = input(false);
  /** In the main panel, "Biblioteca expandida" (desktop, ⤢): a second instance. */
  readonly expanded = input(false);
  /** Its ids' prefix: the column and the expanded view are on screen together. */
  /** The column's ⤢ is on while "Biblioteca expandida" shows. */
  readonly wide = input(false);
  private readonly router = inject(Router);
  /** The address without query or fragment, as the router last settled on it. */
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.split(/[?#]/)[0] ?? ''),
    ),
    { initialValue: this.router.url.split(/[?#]/)[0] ?? '' },
  );
  /**
   * The conversation is on screen (not a media or settings page over it): only then does the
   * row of the collection in use carry the unassigned-people notice.
   */
  private readonly onConversation = computed(() => this.path() === '/');
  /** The library page, in either scope. */
  private readonly onLibrary = computed(() => this.path() === '/biblioteca');
  /** A pinned page stays the current row with its query (/biblioteca?busca=…, -search). */
  protected readonly activeOptions = {
    paths: 'exact',
    queryParams: 'ignored',
    fragment: 'ignored',
    matrixParams: 'ignored',
  } as const;
  /** "Todas as mídias" in the address: the library lists every collection, by that choice. */
  private readonly allInAddress = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.allFromAddress()),
    ),
    { initialValue: this.allFromAddress() },
  );
  /**
   * Biblioteca opens the library of the collection in use; it is the current row only while
   * the library lists every collection ("Todas as mídias", chosen on the page). A library of
   * one collection marks that collection's row, never the pin too (owner, 2026-11-19).
   */
  private readonly libraryCurrent = computed(
    () => this.onLibrary() && this.allInAddress(),
  );
  protected readonly ns = computed(() =>
    this.expanded() ? 'library-wide' : 'library',
  );
  /** The parent closes the drawer and moves focus after each action. */
  readonly acted = output<SidebarAction>();
  readonly collapseToggled = output();
  readonly expandToggled = output();

  protected readonly newConversationLabel = $localize`:@@sidebar.new:Nova conversa`;
  protected readonly newCollectionLabel = $localize`:@@library.newCollection:Novo acervo`;
  protected readonly collapseLabel = $localize`:@@library.collapse:Recolher Sua biblioteca`;
  protected readonly expandLabel = $localize`:@@library.expand:Expandir Sua biblioteca`;
  protected readonly widenLabel = $localize`:@@library.widen:Ampliar Sua biblioteca`;
  protected readonly pinnedLabel = $localize`:@@library.pinned:Fixados`;
  protected readonly collectionsLabel = $localize`:@@library.chipCollections:Acervos`;
  protected readonly conversationsLabel = $localize`:@@library.chipConversations:Conversas`;
  protected readonly documentsLabel = $localize`:@@library.chipDocuments:Documentos`;
  protected readonly kind = signal<LibraryKind | null>(null);
  protected readonly order = signal<LibraryOrder>('recent');
  protected readonly query = signal('');
  protected readonly searching = signal(false);
  /** Folded sections and collection branches ("section:<id>", "branch:<slug>"). */
  private readonly document = inject(DOCUMENT);
  private readonly folded = signal<ReadonlySet<string>>(this.readFolded());
  private readonly view = computed((): LibraryView => ({
    kind: this.kind(),
    order: this.order(),
    query: this.query(),
  }));
  protected readonly chips = computed(() =>
    CHIPS.filter((chip) => chip.kind !== 'audio' || this.audio.shown()).map(
      (chip) => ({ kind: chip.kind, label: chip.label() }),
    ),
  );
  protected readonly orderLabel = computed(() =>
    this.order() === 'recent'
      ? $localize`:@@library.recent:Recentes`
      : $localize`:@@library.alpha:Ordem alfabética`,
  );

  /** One's own AI on free models or a free tier (KBC-023): no spend in US$ to show. */
  protected readonly ownFree = computed(() => {
    const status = this.settings.aiStatus.hasValue()
      ? this.settings.aiStatus.value()
      : null;
    return status?.source === 'own' && status.free;
  });
  /** Served by the app's AI (KBC-022): its researches left instead of a spend in US$. */
  protected readonly appServed = computed(() => {
    const status = this.settings.aiStatus.hasValue()
      ? this.settings.aiStatus.value()
      : null;
    if (status?.source !== 'app' || status.remainingToday === null) return null;
    return {
      remaining: status.remainingToday,
      daily: status.dailyResearches ?? status.remainingToday,
    };
  });

  /** "Biblioteca" (T16, KBC-051 BR-1), else "Mídia" (T14) with a collection chosen. */
  private readonly mediaLink = computed(() => {
    if (hasLibrary(this.session))
      return {
        title: $localize`:@@sidebar.library:Biblioteca`,
        path: '/biblioteca',
      };
    return this.audio.listens() && this.chat.topicSlug() !== null
      ? { title: $localize`:@@sidebar.media:Mídia`, path: '/midia' }
      : null;
  });
  /** The pinned items, all under the audio rule (BR-2). */
  protected readonly pinned = computed((): PinnedItem[] => {
    if (!this.audio.shown() || !shows(this.kind(), 'audio')) return [];
    return [this.libraryItem(), this.bookmarksItem(), this.queueItem()].filter(
      (item): item is PinnedItem => item !== null,
    );
  });
  /**
   * Without audio the pinned items hide; the media library stays one click away beside the
   * filter for who has it (no v1 action is lost, BR-1).
   */
  protected readonly mediaFallback = computed(() =>
    this.audio.shown() ? null : this.mediaLink(),
  );

  protected readonly collections = computed(() =>
    shows(this.kind(), 'collections')
      ? orderCollections(
          this.chat.topicList(),
          this.view(),
          this.recents.collections(),
        ).map((topic) => ({
          topic,
          meta: this.collectionMeta(topic),
          active: this.onConversation() && topic.slug === this.chat.topicSlug(),
          /**
           * The collection in use, marked on every page (green title, overlay, aria-current):
           * the person always sees which one the conversation, the search and the library
           * are about (owner, 2026-11-19).
           */
          lit: topic.slug === this.chat.topicSlug(),
        }))
      : [],
  );
  /** The collections as a tree: each group's top and its sub-collections (D5). */
  protected readonly collectionNodes = computed(() =>
    collectionTree(this.collections()),
  );
  /** Whether any collection has a caret: only then the others keep its place, aligned. */
  protected readonly hasBranches = computed(() =>
    this.collectionNodes().some((node) => node.children.length > 0),
  );
  protected readonly pinnedCount = computed(() => this.pinned().length);
  protected readonly documents = computed(() =>
    shows(this.kind(), 'documents')
      ? orderByTitle(
          inVisibleCollections(this.recents.documents(), this.titles()),
          this.view(),
        ).map((doc) => ({
          ...doc,
          meta: this.titles().get(doc.topic) ?? doc.topic,
        }))
      : [],
  );
  protected readonly showsConversations = computed(() =>
    shows(this.kind(), 'conversations'),
  );
  /** The conversation on screen: the one of the current view (KBC-008 FR-5). */
  protected readonly currentId = computed(() =>
    this.views.current() === 'research'
      ? this.research.conversationId()
      : this.chat.conversationId(),
  );
  protected readonly titles = computed(
    () => new Map(this.chat.topicList().map((t) => [t.slug, t.title])),
  );
  /**
   * The history with how each conversation stands (KBC-029): the one on screen from what this
   * page sees (a search or research still running), the others as the server keeps them.
   */
  protected readonly entries = computed(() => {
    const searching = this.chat.searching() ? this.chat.conversationId() : null;
    const researching = this.research.streaming()
      ? this.research.conversationId()
      : null;
    const now = new Date();
    const list = this.history.conversations().map((conversation) => {
      const running =
        conversation.id === searching || conversation.id === researching;
      const status = running ? 'pending' : conversation.status;
      return {
        ...conversation,
        status,
        when: savedWhen(conversation.updatedAt, now),
      };
    });
    return orderByTitle(list, this.view());
  });
  /** The conversations by recency (D5): Hoje, Últimos 7 dias, Mais antigas. */
  protected readonly conversationGroups = computed(() =>
    groupByRecency(this.entries(), new Date()).map(({ group, items }) => ({
      group,
      label: RECENCY_LABELS[group](),
      items,
    })),
  );
  /** A search shows every match: folded sections and branches open while it is typed. */
  private readonly filtering = computed(() => this.query().trim() !== '');
  /** Nothing of any section matches the library's own search. */
  protected readonly nothingFound = computed(
    () =>
      this.filtering() &&
      this.pinned().length === 0 &&
      this.collections().length === 0 &&
      this.documents().length === 0 &&
      (!this.showsConversations() || this.entries().length === 0),
  );
  protected readonly statusLabels: Record<ConversationStatus, string> = {
    pending: STATUS_LABELS.pending(),
    interrupted: STATUS_LABELS.interrupted(),
    failed: STATUS_LABELS.failed(),
  };
  protected readonly kindLabels: Record<ConversationKind, string> = {
    search: KIND_LABELS.search(),
    research: KIND_LABELS.research(),
  };
  protected readonly flatKindLabels: Record<ConversationKind, string> = {
    search: FLAT_KIND_LABELS.search(),
    research: FLAT_KIND_LABELS.research(),
  };
  /**
   * The wide list (⤢) and the phone Menu draw one list (v2 · Menu lateral aberto): a
   * conversation's cover says its kind and its line names its collection.
   */
  protected readonly flat = computed(() => this.expanded() || this.mobile());
  /**
   * The wide list has no section heads to fold (each section keeps its name for screen
   * readers; Tipo says the kind). The phone Menu keeps them: D5 (each section with its
   * title, count and caret) prevails over the frame where they conflict.
   */
  protected readonly headless = computed(() => this.expanded());
  /**
   * "Enviar documento ou link" (KBC-149 BR-1): who may send audio may send documents (the
   * same permission), into the collection in use.
   */
  protected readonly canSendDocuments = computed(
    () =>
      this.session.me()?.media === true &&
      this.session.can('media') &&
      this.session.can('media-upload') &&
      this.chat.topicSlug() !== null,
  );
  protected readonly currentTopicTitle = computed(() => {
    const slug = this.chat.topicSlug();
    return slug ? (this.titles().get(slug) ?? slug) : '';
  });
  /** "Novo acervo" and "Editar acervo" (KBC-048 FR-6): only with "Criar acervos". */
  protected readonly canCreateCollections = computed(() =>
    this.session.can('collection-create'),
  );

  constructor() {
    this.opens
      .pipe(
        // A failed load is reported by HistoryStore.lastError; the list stays usable.
        switchMap((id) => this.history.load(id).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((conversation) => this.restoreLoaded(conversation));
  }

  protected chooseKind(kind: LibraryKind): void {
    this.kind.update((current) => (current === kind ? null : kind));
  }

  /** Whether a section (or a collection's branch) shows its items. */
  protected isOpen(key: string): boolean {
    if (this.headless() && key.startsWith('section:')) return true;
    return this.filtering() || !this.folded().has(key);
  }

  /** The caret of a collection with sub-collections. */
  protected branchLabel(title: string): string {
    return $localize`:@@library.branch:Sub-acervos de ${title}:title:`;
  }

  protected toggleFold(key: string): void {
    const next = new Set(this.folded());
    if (this.isOpen(key)) next.add(key);
    else next.delete(key);
    this.folded.set(next);
    this.writeFolded(next);
  }

  /**
   * The chips sit on one line, as v2 draws them (the last one under the column's edge): a
   * vertical wheel over them scrolls the line sideways, so a mouse reaches every chip.
   */
  protected scrollChips(event: WheelEvent): void {
    const row = event.currentTarget;
    if (!(row instanceof HTMLElement) || row.scrollWidth <= row.clientWidth)
      return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    row.scrollLeft += event.deltaY;
  }

  protected toggleSearch(): void {
    this.searching.update((on) => !on);
    if (!this.searching()) {
      this.query.set('');
      return;
    }
    // The field opens above the Menu's rows on a phone: take the focus there.
    afterNextRender(
      () => this.document.getElementById(`${this.ns()}-search`)?.focus(),
      { injector: this.injector },
    );
  }

  /** "Nova conversa" starts over in the current view; the other one keeps its conversation. */
  protected startNew(): void {
    if (this.views.current() === 'research') this.research.newConversation();
    else this.chat.newConversation();
    this.acted.emit('new');
  }

  /** Loads the whole conversation, then restores it by kind. */
  protected open(summary: ConversationSummary): void {
    this.opens.next(summary.id);
  }

  protected openDocument(doc: {
    topic: string;
    id: string;
    title: string;
  }): void {
    this.chat.open(doc.topic, { id: doc.id, title: doc.title });
    this.acted.emit('document');
  }

  /**
   * Search re-runs its asks in the search view; research shows what was saved in the
   * research view, never calling the AI again.
   */
  private restoreLoaded(conversation: Conversation): void {
    if (conversation.kind === 'search') {
      this.views.select('search');
      this.chat.restore(conversation);
    } else this.restorer.restore(conversation);
    this.acted.emit('restore');
  }

  protected openMedia(): void {
    this.acted.emit('media');
  }

  /** The name of a row's ⋯ in "Biblioteca expandida". */
  protected rowMenuLabel(title: string): string {
    return $localize`:@@library.rowMore:Mais opções de ${title}:title:`;
  }

  /** "Fechar o player" (KBC-041 AC-11) from the phone Menu: v2 draws no × on the card. */
  protected closePlayer(): void {
    this.closer.run(this.rightPanel.content()?.component === NowPlayingPanel);
    this.acted.emit('player');
  }

  /** "N documentos sem nível" (KBC-107) leads to T24: the drawer closes. */
  protected openLevels(): void {
    this.acted.emit('levels');
  }

  /**
   * A new collection joins the list at once (≤ 2 s, KBC-048 NFR-1), at the top of "Recentes"
   * where it is seen; a renamed one keeps its place. Neither changes the collection in use nor
   * the conversation (KBC-164 BR-3): the new one is in use only once the person picks it.
   */
  protected collectionSaved(topic: Topic): void {
    const created = !this.chat
      .topicList()
      .some((known) => known.slug === topic.slug);
    this.chat.putTopic(topic);
    if (created) this.recents.noteCollection(topic.slug);
  }

  /** A collection of the list becomes the one in use, as the v1 selector did (BR-4, AC-7). */
  protected changeTopic(slug: string): void {
    this.chat.selectTopic(slug);
    this.recents.noteCollection(slug);
    // On the library, a collection is its scope: "Todas as mídias" ends there (the same
    // collection chosen again included), the words searched stay.
    if (this.onLibrary()) {
      const address = this.router.parseUrl(this.router.url);
      address.queryParams = Object.fromEntries(
        Object.entries(address.queryParams).filter(
          ([name]) => name !== ALL_COLLECTIONS_PARAM && name !== 'acervo',
        ),
      );
      void this.router.navigateByUrl(address);
    }
    this.acted.emit('topic');
  }

  /** "Pessoas e permissões" (masters): the Configurações section of its own. */
  protected openPeople(): void {
    this.settings.openSettings('people');
  }

  protected signOut(): void {
    this.signOutAction.run();
  }

  private readFolded(): ReadonlySet<string> {
    try {
      const raw = this.storage()?.getItem(FOLDED_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return new Set(
        Array.isArray(list)
          ? list.filter((key): key is string => typeof key === 'string')
          : [],
      );
    } catch {
      return new Set();
    }
  }

  private writeFolded(keys: ReadonlySet<string>): void {
    try {
      this.storage()?.setItem(FOLDED_KEY, JSON.stringify([...keys]));
    } catch {
      // Blocked storage: the fold lasts until the page reloads.
    }
  }

  private storage(): Storage | null {
    try {
      return this.document.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private collectionMeta(topic: Topic): string {
    if (!topic.canOpen)
      return $localize`:@@library.groupOnly:Só os sub-acervos abaixo`;
    const documents = formatNumber(topic.documentCount, this.locale);
    const texts =
      topic.documentCount === 1
        ? $localize`:@@library.collectionOne:Acervo · 1 documento`
        : $localize`:@@library.collectionMany:Acervo · ${documents}:count: documentos`;
    // v2 · Sua biblioteca: "Acervo · 11 áudios · 1 documento", the audio first.
    const children = this.chat
      .topicList()
      .filter((one) => one.parent === topic.slug)
      .map((one) => one.slug);
    const media = this.counts.mediaIn(topic.slug, children) ?? 0;
    if (media === 0) return texts;
    const audio = formatNumber(media, this.locale);
    const heard =
      media === 1
        ? $localize`:@@library.collectionAudioOne:1 áudio`
        : $localize`:@@library.collectionAudioMany:${audio}:count: áudios`;
    const docs =
      topic.documentCount === 1
        ? $localize`:@@library.documentsOne:1 documento`
        : $localize`:@@library.documentsMany:${documents}:count: documentos`;
    return $localize`:@@library.collectionWithAudio:Acervo · ${heard}:audio: · ${docs}:documents:`;
  }

  private libraryItem(): PinnedItem | null {
    const link = this.mediaLink();
    return link
      ? {
          key: 'library',
          title: link.title,
          meta: this.libraryMeta(),
          path: link.path,
          ...(link.path === '/biblioteca' && {
            current: this.libraryCurrent(),
          }),
          icon: 'library',
          colors: ['#7a3d22', '#2a120a'],
        }
      : null;
  }

  /**
   * What the library holds: "<the collection in use> · 11" (its media, its sub-collections'
   * included), the library being that collection's; "Todas as mídias · 40" while it lists
   * every collection.
   */
  private libraryMeta(): string {
    const topic = this.chat.topic();
    if (this.libraryCurrent() || !topic)
      return this.withCount(
        $localize`:@@library.allMedia:Todas as mídias`,
        this.counts.total(),
      );
    const children = this.chat
      .topicList()
      .filter((one) => one.parent === topic.slug)
      .map((one) => one.slug);
    return this.withCount(
      topic.title,
      this.counts.mediaIn(topic.slug, children),
    );
  }

  private allFromAddress(): boolean {
    const { queryParams } = this.router.parseUrl(this.router.url);
    const value: unknown = queryParams[ALL_COLLECTIONS_PARAM];
    return value === ALL_COLLECTIONS_VALUE;
  }

  /** "Todas as mídias · 11": the count once known. */
  private withCount(label: string, count: number | null): string {
    return count === null
      ? label
      : `${label} · ${formatNumber(count, this.locale)}`;
  }

  /** "Lista · 12 marcadores" (v2 · Sua biblioteca), "Lista" until the count is known. */
  private bookmarksMeta(count: number | null): string {
    const list = $localize`:@@library.bookmarksMeta:Lista`;
    if (count === null) return list;
    const marks = formatNumber(count, this.locale);
    return count === 1
      ? $localize`:@@library.bookmarksMetaOne:Lista · 1 marcador`
      : $localize`:@@library.bookmarksMetaMany:Lista · ${marks}:count: marcadores`;
  }

  private bookmarksItem(): PinnedItem | null {
    return this.audio.listens()
      ? {
          key: 'bookmarks',
          title: $localize`:@@library.bookmarks:Meus marcadores`,
          meta: this.bookmarksMeta(this.counts.bookmarks()),
          path: '/midia/marcadores',
          icon: 'bookmarkFill',
          colors: ['#5b3fd1', '#9ad1ff'],
        }
      : null;
  }

  private queueItem(): PinnedItem | null {
    if (!this.queue.allowed()) return null;
    const active = this.queue.active();
    // v2 · Sua biblioteca: what needs the person comes first ("3 precisam de atenção").
    const attention = this.queue
      .items()
      .filter(({ phase }) => phase === 'attention').length;
    return {
      key: 'queue',
      title: $localize`:@@library.queue:Fila de processamento`,
      meta:
        attention === 1
          ? $localize`:@@library.queueAttentionOne:1 precisa de atenção`
          : attention > 1
            ? $localize`:@@library.queueAttention:${attention}:count: precisam de atenção`
            : active
              ? $localize`:@@library.queueActive:${active}:count: em processamento`
              : $localize`:@@library.queueIdle:Nada em processamento`,
      path: '/fila',
      icon: 'upload',
      colors: ['#1f9c56', '#0b3d22'],
    };
  }
}

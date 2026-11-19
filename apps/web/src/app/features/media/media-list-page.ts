import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
  viewChildren,
  type TemplateRef,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  listeningStateOf,
  mediaListSchema,
  type LibrarySort,
  type LibraryView,
  type LibraryItem,
  type MediaItem,
  type MediaListItem,
} from '@kb-chat/contracts';
import { formatClock, formatDuration, resumeFrom } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { alsoRemovesText, tracksInTheWay } from './track-removal.js';
import { SessionStore } from '@core/auth/session-store.js';
import { MediaApi, mediaListUrl } from '@core/media/media-api.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { PageHeader } from '@features/shell/page-header.js';
import {
  CollectionHeading,
  type HeadingScope,
} from '@features/chat/collection-heading.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  EMPTY,
  distinctUntilChanged,
  filter,
  interval,
  pairwise,
  switchMap,
} from 'rxjs';
import {
  ANY_AUTHOR,
  NO_AUTHOR,
  authorFilterOptions,
  matchesAuthor,
} from './media-authors.js';
import { PlayNow } from './library/play-now.js';
import { LibrarySortMenu } from './library/library-sort.js';
import { MenuButton, type MenuOption } from './menu-button.js';
import { keepFocusedInView } from './keep-in-view.js';
import {
  pollEveryOf,
  isLowConfidence,
  lowNoticeOf,
  statusTextOf,
  transcriptionTextOf,
} from './media-labels.js';
import { matchesTitle, newlyReady, summaryOf } from './media-summary.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { detailsSavedText } from './edit-labels.js';
import { MediaLevelBadge } from './media-level-badge.js';
import { EditMediaDialog, type MediaEdited } from './edit-media-dialog.js';
import { MovedNotice, mediaMoveOf, type MediaMove } from './moved-notice.js';
import { injectOpenPreparations } from './preparation/open-preparations.js';
import { PreparationEntry } from './preparation/preparation-entry.js';
import { scrollPageByKey } from './page-keys.js';
import { RowMenu } from './row-menu.js';
import { TrackGroup } from './library/track-group.js';
import { UploadPanel } from './upload-panel.js';
import { UiBanner } from '@ui/banner.js';
import { UiButton, UiChip, UiIconButton } from '@ui/button.js';
import { UiCover, coverGradient } from '@ui/cover.js';
import { UiEmptyState } from '@ui/empty-state.js';
import { UiIcon } from '@ui/icon.js';
import { UiPill, type Tone } from '@ui/pill.js';
import { UiProgress } from '@ui/progress.js';

/** The title filter appears from this many items on (T14). */
export const FILTER_FROM = 11;

/** With no collection, the frame's olive (media-list tint). */
const MEDIA_TINT = '#5a5a1a';

/** The shell's phone layout (chat-page: desktop from 1024 px). */
const PHONE_QUERY = '(max-width: 1023px)';
const phoneNow = (): boolean =>
  typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;

/** The phone's listening chips (media-list@mobile: "Em andamento", "Não ouvidas"). */
type Listening = 'in-progress' | 'unheard';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });
const timeOf = (iso: string | null): number => (iso ? Date.parse(iso) : 0);

/** Why it failed in a word or two, for the table's pill (media-list: "Falhou: arquivo inválido"). */
const SHORT_FAILURES: Record<
  NonNullable<MediaItem['failure']>,
  () => string
> = {
  'invalid-audio': () =>
    $localize`:@@media.failureShort.invalid:arquivo inválido`,
  'conversion-failed': () =>
    $localize`:@@media.failureShort.conversion:conversão`,
  'too-many-attempts': () =>
    $localize`:@@media.failureShort.conversion:conversão`,
  'upload-abandoned': () => $localize`:@@media.failureShort.upload:envio`,
};

const shortFailureOf = (item: MediaItem): string =>
  item.failure ? SHORT_FAILURES[item.failure]() : '';

/** The list in the order chosen on the phone's line (the library's words, BR-7). */
function sortedBy<T extends MediaItem>(
  items: readonly T[],
  sort: LibrarySort,
): T[] {
  const list = [...items];
  if (sort === 'title')
    return list.sort((a, b) => collator.compare(a.title, b.title));
  if (sort === 'duration')
    return list.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  if (sort === 'author')
    return list.sort((a, b) =>
      collator.compare(a.author?.name ?? '\uffff', b.author?.name ?? '\uffff'),
    );
  if (sort === 'recently-added')
    return list.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  if (sort === 'recently-played')
    return list.sort(
      (a, b) => timeOf(b.positionUpdatedAt) - timeOf(a.positionUpdatedAt),
    );
  return list;
}

/**
 * "Mídia" (screens.md T14, KBC-034 FR-6; v2 KBC-128 media-list): the selected collection's
 * audio as an album page — its cover, ▶ and shuffle, the upload for who may send, the title
 * filter and "Autoria", the track table (# · title · sent · status · ⏱ · ⋯) with the status
 * in a word, and the masters' "Tentar de novo" and "Remover". On a phone the shell's top row
 * says the collection (PageHeader) and the list is the library's (media-list@mobile): chips,
 * the order and the view.
 */
@Component({
  selector: 'app-media-list-page',
  imports: [
    RouterLink,
    DatePipe,
    NgTemplateOutlet,
    LibrarySortMenu,
    MenuButton,
    UiChip,
    UiIconButton,
    MediaLevelBadge,
    EditMediaDialog,
    MovedNotice,
    UploadPanel,
    RowMenu,
    TrackGroup,
    PreparationEntry,
    UiBanner,
    UiButton,
    UiCover,
    UiEmptyState,
    UiIcon,
    UiPill,
    UiProgress,
  ],
  templateUrl: './media-list-page.html',
  styleUrl: './media-list-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(focusin)': 'keepInView($event)',
    '(document:keydown)': 'pageKey($event)',
    '[style.--media-tint]': 'tint()',
  },
})
export class MediaListPage {
  private readonly chat = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly api = inject(MediaApi);
  private readonly injector = inject(Injector);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly locale = inject(LOCALE_ID);
  private readonly removeDialog =
    viewChild<ElementRef<HTMLDialogElement>>('removeDialog');
  private readonly rows = viewChildren<ElementRef<HTMLElement>>('row');
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly engine = inject(MediaEngine);
  private readonly playNow = inject(PlayNow);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly phoneActions =
    viewChild<TemplateRef<unknown>>('phoneActions');
  private readonly phoneFilterBox =
    viewChild<ElementRef<HTMLInputElement>>('phoneFilterBox');
  /** The item to focus once it is on screen (after an upload). */
  private pendingFocus: string | null = null;

  protected readonly topic = this.chat.topic;
  protected readonly topics = this.chat.topicList;
  /** A phone (the shell's layout below 1024 px). */
  protected readonly phone = signal(phoneNow());
  /** The album's colour: its cover's (media-list: the "AL" cover's olive under the header). */
  protected readonly tint = computed(() => {
    const title = this.topic()?.title;
    return title ? coverGradient(title)[0] : MEDIA_TINT;
  });
  /** The phone's filter row, opened by the top row's 🔍. */
  protected readonly filterOpen = signal(false);
  protected readonly listening = linkedSignal<string | null, Listening | null>({
    source: this.chat.topicSlug,
    computation: () => null,
  });
  protected readonly sort = signal<LibrarySort>('recently-played');
  protected readonly view = signal<LibraryView>('list');
  /** "Acervo — Hermetismo": the heading's name, the two lines of the header in one. */
  protected readonly headingText = computed(() => {
    const word = $localize`:@@media.kicker:Acervo`;
    const topic = this.topic();
    return topic ? `${word} — ${topic.title}` : word;
  });
  /** Where each preparation stopped (KBC-072 FR-6). */
  protected readonly preparations = injectOpenPreparations();
  protected readonly list = httpResource(
    () => {
      const slug = this.chat.topicSlug();
      return slug ? mediaListUrl(slug) : undefined;
    },
    { parse: (body) => mediaListSchema.parse(body) },
  );
  protected readonly items = computed(() =>
    this.list.hasValue() ? this.list.value().items : [],
  );
  protected readonly query = signal('');
  /** "Autoria" (KBC-049 FR-4): every author by default, reset on a switch. */
  protected readonly author = linkedSignal({
    source: this.chat.topicSlug,
    computation: () => ANY_AUTHOR,
  });
  protected readonly authorOptions = computed(() =>
    authorFilterOptions(this.items()),
  );
  /** Shown when the list has two or more authorships to tell apart. */
  protected readonly showAuthorFilter = computed(
    () => this.authorOptions().length >= 2 || this.emptyLoaded(),
  );
  /** A collection with nothing yet keeps its filter and "Autoria" (media-list-empty). */
  private readonly emptyLoaded = computed(
    () => this.list.hasValue() && this.items().length === 0,
  );
  protected readonly visible = computed(() => {
    const listening = this.listening();
    return sortedBy(
      this.items().filter(
        (item) =>
          matchesTitle(item, this.query()) &&
          matchesAuthor(item, this.author()) &&
          (listening === null || listeningStateOf(item) === listening),
      ),
      // A desktop has no order to choose: the album goes as sent, newest first, as its
      // "Enviado em" column reads (v2 · media-list); the phone's line chooses it.
      this.phone() ? this.sort() : 'recently-added',
    );
  });
  protected readonly showFilter = computed(
    () => this.items().length >= FILTER_FROM || this.emptyLoaded(),
  );
  /** "Mestre Laércio e outros autores · 11 áudios · 6 min" (media-list's header). */
  protected readonly headerMeta = computed(() => {
    const items = this.items();
    if (items.length === 0) {
      // Its main author leads an empty collection too (media-list-empty).
      const none = $localize`:@@media.noneYet:nenhum áudio ainda`;
      const lead = this.topic()?.mainAuthor?.name;
      return lead ? `${lead} · ${none}` : none;
    }
    // The collection's main author leads, even with none of its audio (v2 · media-list).
    const main =
      this.topic()?.mainAuthor ??
      items.find((item) => item.author?.main)?.author ??
      items.find((item) => item.author)?.author ??
      null;
    const others = items.some((item) => item.author?.slug !== main?.slug);
    const who = main
      ? others
        ? $localize`:@@media.authorsAndOthers:${main.name}:name: e outros autores`
        : main.name
      : '';
    const summary = summaryOf(items);
    return who ? `${who} · ${summary}` : summary;
  });
  protected readonly emptyText = computed(() => {
    const topic = this.topic();
    // The phone's empty state is the title and the button (media-list-empty@mobile).
    return topic && this.canUpload() && !this.phone()
      ? $localize`:@@media.emptyText:Envie a primeira gravação de ${topic.title}:title:.`
      : '';
  });
  protected readonly filterEmptyTitle = computed(() =>
    this.query()
      ? $localize`:@@media.filterEmpty:Nenhum áudio com “${this.query()}:query:” no título`
      : $localize`:@@media.authorFilterEmpty:Nenhum áudio com estes filtros`,
  );
  protected readonly authorMenu = computed<readonly MenuOption[]>(() => {
    const options = this.authorOptions().map((one) => ({
      id: one.value,
      label: `${one.label} (${one.count})`,
      checked: one.value === this.author(),
    }));
    // An empty collection still has the chip (media-list-empty@mobile): every authorship.
    return options.length > 0
      ? options
      : [
          {
            id: ANY_AUTHOR,
            label: $localize`:@@library.allAuthorships:Todas as autorias`,
            checked: true,
          },
        ];
  });
  protected readonly authorName = computed(() => {
    const chosen = this.author();
    if (chosen === ANY_AUTHOR) return '';
    if (chosen === NO_AUTHOR) return AUTHORSHIP_LABELS['outros-autores'];
    return (
      this.items().find((item) => item.author?.slug === chosen)?.author?.name ??
      chosen
    );
  });
  protected readonly clearAuthorLabel = computed(
    () =>
      $localize`:@@library.clearAuthorship:Tirar o filtro de autoria: ${this.authorName()}:name:`,
  );
  protected readonly viewToggleLabel = computed(() =>
    this.view() === 'grid'
      ? $localize`:@@library.showList:Ver como lista`
      : $localize`:@@library.showGrid:Ver como grade`,
  );
  /** What the green ▶ plays: the first ready audio of the list on screen. */
  protected readonly firstPlayable = computed(
    () => this.visible().find((item) => item.status === 'ready') ?? null,
  );
  protected readonly playingId = computed(() =>
    this.engine.playing() ? (this.engine.source()?.id ?? null) : null,
  );
  /** The list's ▶ (or 🔀) started what plays: only then the header's ▶ is ⏸ (a playlist's). */
  protected readonly listPlaying = computed(
    () =>
      this.items().some((item) => item.id === this.playingId()) &&
      this.playNow.playingList() === this.listKey(),
  );
  /** This collection's list, as the header's ▶ names it to PlayNow. */
  private readonly listKey = computed(
    () => `midia:${this.chat.topicSlug() ?? ''}`,
  );
  protected readonly playAllLabel = computed(() =>
    this.listPlaying()
      ? $localize`:@@library.pauseList:Pausar a lista`
      : $localize`:@@library.playList:Tocar a primeira da lista`,
  );
  /** The header's ⋯ (media-list): what has no button of its own in the frame's bar. */
  protected readonly headerOptions = computed<readonly MenuOption[]>(() => [
    {
      id: 'reload',
      label: $localize`:@@media.reloadList:Atualizar a lista`,
      icon: 'refresh',
    },
    {
      id: 'copy-link',
      label: $localize`:@@media.copyCollectionLink:Copiar link do acervo`,
      icon: 'link',
    },
  ]);
  protected readonly canUpload = computed(() =>
    this.session.can('media-upload'),
  );
  protected readonly isMaster = this.session.isMaster;
  protected readonly loadError = computed(() => {
    const err = this.list.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly uploading = signal(false);
  protected readonly removing = signal<MediaItem | null>(null);
  /** The tracks that go with it, once the API named them (KBC-068). */
  protected readonly removingTracks = signal<readonly string[] | null>(null);
  protected readonly removingTracksText = computed(() =>
    alsoRemovesText(this.removingTracks() ?? []),
  );
  protected readonly editing = signal<MediaItem | null>(null);
  /** The last audio moved from here (FR-3); cleared on a switch. */
  protected readonly moved = linkedSignal<string | null, MediaMove | null>({
    source: this.chat.topicSlug,
    computation: () => null,
  });
  protected readonly actionError = signal('');
  protected readonly announcement = signal('');
  /** Apart from `announcement`: a reload after an action must not replace what it said. */
  protected readonly readyNotice = signal('');
  /** Where the last upload went, when it was another collection; cleared on a switch. */
  protected readonly sentElsewhere = linkedSignal({
    source: this.chat.topicSlug,
    computation: () => '',
  });

  constructor() {
    inject(PageHeader).own(
      computed(() => ({
        title: this.topic()?.title ?? $localize`:@@media.title:Mídia`,
        back: '/',
        actions: this.phoneActions() ?? null,
        tint: this.tint(),
      })),
    );
    this.followLayout();
    inject(CollectionHeading).follow(
      computed<HeadingScope | null>(() => {
        const slug = this.chat.topicSlug();
        return slug ? { kind: 'topic', slug } : null;
      }),
    );
    this.pollWhileInFlight();
    this.announceReady();
    afterRenderEffect(() => this.focusPending(this.rows()));
  }

  /** The scrolling keys with nothing focused move the album (its own scroller). */
  protected pageKey(event: KeyboardEvent): void {
    scrollPageByKey(this.host.nativeElement, event);
  }

  protected keepInView(event: FocusEvent): void {
    keepFocusedInView(event);
  }

  /** Where its transcription is (KBC-036 FR-1), next to the status. */
  protected transcriptionOf(item: MediaItem): string {
    return transcriptionTextOf(item, this.locale);
  }

  protected isLow(item: MediaItem): boolean {
    return isLowConfidence(item);
  }

  protected lowNoticeOf(item: MediaItem): string {
    return lowNoticeOf(item);
  }

  protected statusOf(item: MediaItem): string {
    return statusTextOf(item);
  }

  /** The pill's tone backs its words: ready, failed, or still on its way. */
  protected statusToneOf(item: MediaItem): Tone {
    if (item.status === 'ready') return 'ok';
    return item.status === 'failed' ? 'err' : 'info';
  }

  /**
   * The status in a few words, its tone backing them (media-list: "Transcrita", "Aguardando o
   * transcritor", "Falhou: …"; a phone's are shorter: "Aguardando", "Baixa confiança").
   */
  protected pillOf(item: MediaItem): { text: string; tone: Tone } | null {
    const phone = this.phone();
    if (item.status === 'failed')
      return {
        text: phone
          ? $localize`:@@media.status.failedWord:Falhou`
          : $localize`:@@media.status.failedShort:Falhou: ${shortFailureOf(item)}:reason:`,
        tone: 'err',
      };
    if (item.status !== 'ready')
      return { text: this.statusOf(item), tone: 'info' };
    return this.transcriptionPillOf(item, phone);
  }

  /**
   * A ready audio: where its transcription stands. The phone's line says nothing of a plain
   * ready audio (media-list@mobile).
   */
  private transcriptionPillOf(
    item: MediaItem,
    phone: boolean,
  ): { text: string; tone: Tone } | null {
    const { status } = item.transcription;
    if (status === 'waiting')
      return {
        text: phone
          ? $localize`:@@queue.pill.waiting:Aguardando`
          : $localize`:@@media.pill.waitingTranscriber:Aguardando o transcritor`,
        tone: 'warn',
      };
    if (status === 'failed')
      return { text: transcriptionFailed(), tone: 'err' };
    if (status === 'transcribing')
      return { text: this.transcriptionOf(item), tone: 'info' };
    if (isLowConfidence(item))
      return {
        text: phone
          ? $localize`:@@media.pill.lowShort:Baixa confiança`
          : $localize`:@@media.pill.low:Transcrição de baixa confiança`,
        tone: 'warn',
      };
    if (phone) return null;
    return status === 'done'
      ? { text: $localize`:@@media.pill.transcribed:Transcrita`, tone: 'ok' }
      : { text: this.statusOf(item), tone: 'ok' };
  }

  /** The words the pill leaves out, for a screen reader (UP-20). */
  protected detailOf(item: MediaItem): string {
    return [
      item.status === 'failed' ? this.statusOf(item) : '',
      this.transcriptionOf(item),
      this.lowNoticeOf(item),
      this.resumeTextOf(item),
    ]
      .filter((words) => words !== '')
      .join(' · ');
  }

  protected authorOf(item: MediaItem): string {
    return item.author?.name ?? AUTHORSHIP_LABELS['outros-autores'];
  }

  /** "Tocar em seguida": after the one playing, said aloud (or it plays now). */
  protected playNext(item: MediaItem): void {
    if (this.playNow.playNext(item))
      this.announcement.set(
        $localize`:@@library.playsNext:“${item.title}:title:” toca em seguida.`,
      );
  }

  /** The recordings whose tracks are open under them (v2 media-list, as the library). */
  protected readonly openTracks = signal<ReadonlySet<string>>(new Set());

  protected toggleTracks(id: string): void {
    this.openTracks.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected tracksLabelOf(item: MediaListItem): string {
    const count = item.tracks.length;
    return count === 1
      ? $localize`:@@library.tracksOne:1 faixa`
      : $localize`:@@library.tracks:${count}:count: faixas`;
  }

  /** The library's track rows read a recording of the library: the same item, as audio. */
  protected asRecording(item: MediaListItem): LibraryItem {
    const audio = <T extends MediaItem>(one: T) => ({
      ...one,
      kind: 'audio' as const,
      lastPlayedAt: one.positionUpdatedAt,
    });
    return { ...audio(item), tracks: item.tracks.map(audio) };
  }

  protected play(item: MediaItem): void {
    this.playNow.play(item);
  }

  /** The header's ▶: pauses what of this list plays, or plays its first ready audio. */
  protected playAll(): void {
    const playing = this.listPlaying()
      ? this.items().find((item) => item.id === this.playingId())
      : undefined;
    if (playing) {
      this.playNow.play(playing);
      return;
    }
    const item = this.firstPlayable();
    if (item) this.playNow.playList(this.listKey(), item);
  }

  protected playAny(): void {
    const ready = this.visible().filter((item) => item.status === 'ready');
    const item = ready[Math.floor(Math.random() * ready.length)];
    if (item) this.playNow.playList(this.listKey(), item);
  }

  protected headerAction(id: string): void {
    if (id === 'reload') this.reload();
    else if (id === 'copy-link')
      this.copy(['/midia'], this.topic()?.title ?? '');
  }

  protected copyLink(item: MediaItem): void {
    this.copy(['/midia', item.id], item.title);
  }

  /** "Copiar link" (desktop) / "Compartilhar" (phone, the system's sheet when it has one). */
  private copy(path: readonly string[], title: string): void {
    const view = this.host.nativeElement.ownerDocument.defaultView;
    const url = new URL(
      this.router.serializeUrl(this.router.createUrlTree([...path])),
      view?.location.origin ?? 'http://localhost',
    ).toString();
    const nav = view?.navigator;
    const failed = () =>
      this.actionError.set(
        $localize`:@@library.linkFailed:Não consegui copiar o link. Abra a mídia e copie o endereço.`,
      );
    if (this.phone() && nav?.share) {
      nav.share({ title, url }).catch(() => undefined);
      return;
    }
    if (!nav?.clipboard) {
      failed();
      return;
    }
    nav.clipboard
      .writeText(url)
      .then(
        () =>
          this.announcement.set($localize`:@@library.linkCopied:Link copiado.`),
        failed,
      );
  }

  /** The phone's 🔍 opens the filter row with the cursor in it; again, closes it. */
  protected toggleFilter(): void {
    const open = !(this.filterOpen() || this.query() !== '');
    this.filterOpen.set(open);
    if (!open) this.query.set('');
    else
      afterNextRender(() => this.phoneFilterBox()?.nativeElement.focus(), {
        injector: this.injector,
      });
  }

  protected showAll(): void {
    this.listening.set(null);
    this.author.set(ANY_AUTHOR);
  }

  protected toggleListening(state: Listening): void {
    this.listening.set(this.listening() === state ? null : state);
  }

  protected chooseAuthor(value: string): void {
    this.author.set(this.author() === value ? ANY_AUTHOR : value);
  }

  private followLayout(): void {
    const query =
      this.host.nativeElement.ownerDocument.defaultView?.matchMedia?.(
        PHONE_QUERY,
      );
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) =>
      this.phone.set(event.matches);
    query.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() =>
      query.removeEventListener('change', onChange),
    );
  }

  protected menuLabelOf(item: MediaItem): string {
    return $localize`:@@media.moreActions:Mais ações para ${item.title}:title:`;
  }

  /** "Continuar de 23:10" for a media with a saved position, not yet heard (T14). */
  protected resumeTextOf(item: MediaItem): string {
    const at =
      item.status === 'ready'
        ? resumeFrom(item.positionMs, item.durationMs)
        : null;
    return at === null
      ? ''
      : $localize`:@@media.resumeFrom:Continuar de ${formatClock(at)}:time:`;
  }

  /** How much of it was heard, for the thin bar under the row. */
  protected percentOf(item: MediaItem): number {
    return item.durationMs ? (item.positionMs / item.durationMs) * 100 : 0;
  }

  protected durationOf(item: MediaItem): string {
    return item.durationMs === null ? '' : formatDuration(item.durationMs);
  }

  protected filterBy(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }

  protected clearFilter(): void {
    this.query.set('');
    this.author.set(ANY_AUTHOR);
    this.listening.set(null);
  }

  protected openUpload(): void {
    this.sentElsewhere.set('');
    this.uploading.set(true);
  }

  protected uploadClosed(): void {
    this.uploading.set(false);
  }

  /**
   * The new item lands on top, "Na fila", with the focus on it (UP-01); one sent to another
   * collection is not on this list, so the page says where it went (UP-01, MA-25).
   */
  protected uploaded(item: MediaItem): void {
    if (item.topic !== this.chat.topicSlug()) {
      const title =
        this.topics().find((topic) => topic.slug === item.topic)?.title ??
        item.topic;
      this.sentElsewhere.set(
        $localize`:@@media.sentElsewhere:${item.title}:title: foi enviado para o acervo ${title}:topic:.`,
      );
      return;
    }
    this.pendingFocus = item.id;
    this.list.reload();
    // Several files stay on this list: each says where its preparation stopped (FR-6).
    this.preparations.reload();
  }

  protected retry(item: MediaItem): void {
    this.actionError.set('');
    this.api
      .retry(item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.list.reload(),
        error: (err: unknown) =>
          this.actionError.set(errorMessage(toUiErrorCode(err))),
      });
  }

  protected openEdit(item: MediaItem): void {
    this.moved.set(null);
    this.editing.set(item);
  }

  protected editClosed(): void {
    this.editing.set(null);
  }

  /** Saved (FR-2). A row that left took its ⋯ along: the focus stays on the page (NG-30). */
  protected edited({ before, after }: MediaEdited): void {
    this.list.reload();
    const moved = before.topic !== after.topic;
    const move = moved ? mediaMoveOf(after, this.topics()) : null;
    this.moved.set(move);
    this.announcement.set(move?.text ?? detailsSavedText());
    if (!this.staysListed(after)) this.heading().nativeElement.focus();
  }

  /** In this list (a sub-collection's items are too) and in what the filters show. */
  private staysListed(item: MediaItem): boolean {
    const slug = this.chat.topicSlug();
    const parent = this.topics().find((one) => one.slug === item.topic)?.parent;
    return (
      (item.topic === slug || parent === slug) &&
      matchesTitle(item, this.query()) &&
      matchesAuthor(item, this.author())
    );
  }

  protected openMovedTopic(topic: string): void {
    this.chat.selectTopic(topic);
  }

  protected askRemove(item: MediaItem): void {
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
    this.api
      .remove(item.id, { cascade })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.removed(item),
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

  /** The row is gone: say so and keep the focus on the page, not on <body> (NG-30). */
  private removed(item: MediaItem): void {
    this.list.reload();
    this.announcement.set(
      $localize`:@@media.removedAnnouncement:${item.title}:title: foi removido.`,
    );
    this.heading().nativeElement.focus();
  }

  protected cancelRemove(): void {
    this.removeDialog()?.nativeElement.close();
  }

  protected removeClosed(): void {
    this.removing.set(null);
    this.removingTracks.set(null);
  }

  protected reload(): void {
    this.list.reload();
  }

  private pollWhileInFlight(): void {
    const every = computed(() => pollEveryOf(this.items(), this.pollMs));
    toObservable(every)
      .pipe(
        distinctUntilChanged(),
        switchMap((ms) => (ms === null ? EMPTY : interval(ms))),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.list.reload());
  }

  /** "Palestra de 1998 está pronta." once, in the live region (T14). */
  private announceReady(): void {
    toObservable(this.items)
      .pipe(
        pairwise(),
        filter(([before, after]) => newlyReady(before, after).length > 0),
        takeUntilDestroyed(),
      )
      .subscribe(([before, after]) => {
        const titles = newlyReady(before, after).map((item) => item.title);
        this.readyNotice.set(
          titles.length === 1
            ? $localize`:@@media.readyOne:${titles[0]}:title: está pronta.`
            : $localize`:@@media.readyMany:${titles.join(', ')}:titles: estão prontas.`,
        );
      });
  }

  private focusPending(rows: readonly ElementRef<HTMLElement>[]): void {
    const id = this.pendingFocus;
    if (!id) return;
    const row = rows.find((ref) => ref.nativeElement.dataset['mediaId'] === id);
    if (!row) return;
    this.pendingFocus = null;
    row.nativeElement.focus();
  }
}

const transcriptionFailed = (): string =>
  $localize`:@@media.transcription.failed:A transcrição falhou`;

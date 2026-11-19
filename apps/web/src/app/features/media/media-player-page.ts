import {
  DOCUMENT,
  DatePipe,
  NgTemplateOutlet,
  formatDate,
} from '@angular/common';
import { seenAtFormat } from '@core/i18n/date-formats.js';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  type ParamMap,
} from '@angular/router';
import {
  EMPTY_FILTERS,
  SEARCH_KINDS,
  mediaEditSchema,
  mediaIdSchema,
  mediaItemSchema,
  mediaTranscriptSchema,
  type MediaItem,
} from '@kb-chat/contracts';
import {
  formatClock,
  formatDuration,
  parseWebVtt,
  resumeFrom,
  startFromParam,
} from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { SessionStore } from '@core/auth/session-store.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { MediaSessionAdapter } from '@core/media/media-session.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import {
  mediaStreamUrl,
  mediaSubtitlesUrl,
  mediaTranscriptUrl,
  mediaUrl,
} from '@core/media/media-api.js';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { TranscriptPreferences } from '@core/media/transcript-preferences.js';
import { TracksStore } from '@core/media/tracks-store.js';
import { editPagePath, mediaEditUrl } from '@core/media/media-edit-api.js';
import { TrackPublicationStatus } from './track-publication/track-publication-status.js';
import { preparationPagePath } from '@core/media/preparation-api.js';
import {
  EMPTY,
  distinctUntilChanged,
  filter,
  interval,
  map,
  switchMap,
  take,
} from 'rxjs';
import {
  pollEveryOf,
  isLowConfidence,
  statusTextOf,
  transcriptionTextOf,
} from './media-labels.js';
import {
  CollectionHeading,
  type HeadingScope,
} from '@features/chat/collection-heading.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { PreparationEntry } from './preparation/preparation-entry.js';
import { detailsSavedText, editDetailsLabel } from './edit-labels.js';
import { EditMediaDialog, type MediaEdited } from './edit-media-dialog.js';
import { hasLibrary } from './library/library-access.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { MediaPlayer } from './player/media-player.js';
import { cuesWithSpeakers } from './voices/speaker-names.js';
import { VoicesPanel } from './voices/voices-panel.js';
import { PlayerShortcuts } from './player/player-shortcuts.js';
import { TranscribeAgain } from './transcribe-again.js';
import { TranscribeWithGroq } from './transcribe-with-groq.js';
import { TranscriptPanel } from './transcript/transcript-panel.js';
import { TrackNavList } from './tracks/track-nav-list.js';
import { TrackAboutView } from './track-about-view.js';
import { TrackSubjectsView } from './track-subjects-view.js';
import { MovedBookmarksNotice } from './track-edit/moved-bookmarks-notice.js';
import { TrackActions } from './track-edit/track-actions.js';
import type { MenuOption } from './menu-button.js';
import {
  UiBanner,
  UiButton,
  coverCode,
  coverGradient,
  NEUTRAL_COVER,
  UiChip,
  UiCover,
  UiIcon,
  UiPill,
  type Tone,
} from '@ui/index.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { PlayerAbout } from './player/player-about.js';
import { PlayerPanel } from './player/player-panel.js';
import { PlayerPanelTabs } from './player/player-panel-tab.js';

/** The v2 shell's desktop width (chat-page.ts): "Sobre" goes to the right panel there. */
const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * The body of the v2 player (KBC-129 FR-3): the transcript, the recording's tracks when it
 * has approved ones, or, for who edits, the voices.
 */
export type PlayerView = 'transcript' | 'tracks' | 'voices';

/**
 * One media item (screens.md T15): its title, authorship and length, and the player once
 * it is ready. Opening it never plays (KBC-041 BR-3): with a saved position it offers
 * "Continuar de" and "Começar do início". Leaving it while it plays keeps it playing in
 * the mini-player (FR-8); leaving it paused stops it.
 */
/** Frames to wait for the panel beside the page to draw its bookmarks (about half a second). */
const FOCUS_TRIES = 30;

/** What the page says while a transcription waits for the transcriber (pBody o.waiting). */
interface WaitingWords {
  /** The empty state's and the banner's title. */
  readonly title: string;
  /** Since when it is off, or that none is paired, as a sentence; '' when it is on. */
  readonly off: string;
  /** The header's short pill (pHeader waitStatus, T21's 'Retranscrevendo'). */
  readonly pill: string;
  /** Beside the pill, in words, while there is no transcript yet. */
  readonly why: string;
}

/** Since when the transcriber is off, or that none is paired: a sentence and short words. */
function whyItWaits(
  transcription: MediaItem['transcription'],
  locale: string,
): { readonly off: string; readonly short: string } {
  const since = transcription.transcriberOffSince;
  if (transcription.transcriber === 'off' && since) {
    const date = formatDate(since, seenAtFormat(), locale);
    return {
      off: $localize`:@@player.transcriberOffSince:Desligado desde ${date}:date:.`,
      short: $localize`:@@player.offSinceShort:desligado desde ${date}:date:`,
    };
  }
  if (transcription.transcriber === 'none')
    return {
      off: $localize`:@@player.noTranscriber:Nenhum transcritor pareado.`,
      short: $localize`:@@player.noTranscriberShort:nenhum transcritor pareado`,
    };
  return { off: '', short: '' };
}

function waitingWordsOf(media: MediaItem, locale: string): WaitingWords | null {
  const transcription = media.transcription;
  if (
    media.status !== 'ready' ||
    transcription.status !== 'waiting' ||
    transcription.route !== 'transcriber'
  )
    return null;
  const first = transcription.version === null;
  const title = first
    ? $localize`:@@media.transcription.waiting:Aguardando o transcritor`
    : $localize`:@@player.retranscribingWaiting:Retranscrevendo: aguardando o transcritor`;
  const { off, short } = whyItWaits(transcription, locale);
  return {
    title,
    off,
    pill: first
      ? title
      : $localize`:@@player.retranscribingPill:Retranscrevendo`,
    why: first ? short : '',
  };
}

@Component({
  selector: 'app-media-player-page',
  imports: [
    PreparationEntry,
    RouterLink,
    DatePipe,
    NgTemplateOutlet,
    MediaPlayer,
    PlayerAbout,
    EditMediaDialog,
    TranscribeAgain,
    TranscribeWithGroq,
    TranscriptPanel,
    VoicesPanel,
    TrackNavList,
    TrackAboutView,
    TrackSubjectsView,
    TrackActions,
    MovedBookmarksNotice,
    TrackPublicationStatus,
    UiBanner,
    UiButton,
    UiChip,
    UiCover,
    UiIcon,
    UiPill,
  ],
  templateUrl: './media-player-page.html',
  styleUrl: './media-player-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)':
      'shortcuts.handle($event, "page", { captions: hasTranscript() })',
  },
})
export class MediaPlayerPage {
  private readonly engine = inject(MediaEngine);
  /** "← Biblioteca" for who has the library (KBC-051), "← Mídia" otherwise. */
  private readonly session = inject(SessionStore);
  protected readonly backToLibrary = computed(() => hasLibrary(this.session));
  private readonly saver = inject(ProgressSaver);
  protected readonly shortcuts = inject(PlayerShortcuts);
  private readonly title = inject(Title);
  private readonly route = inject(ActivatedRoute);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly preferences = inject(TranscriptPreferences);
  private readonly listening = inject(ListeningPreferences);
  /** The collections the person sees, for "Editar informações" (KBC-050). */
  private readonly chat = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly views = inject(ViewStore);
  protected readonly topics = this.chat.topicList;
  protected readonly canSearch = computed(() => this.session.can('search'));
  protected readonly editLabel = editDetailsLabel();
  protected readonly editing = signal(false);
  protected readonly announcement = signal('');
  private readonly tracks = inject(TracksStore);
  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
  /** `?t=754`: where the person asked to start (KBC-038 FR-5); wins over the saved one. */
  private readonly startAt = toSignal(
    this.route.queryParamMap.pipe(
      map((params) => startFromParam(params.get('t'))),
    ),
    { initialValue: null },
  );

  /** `?track=3`: opens at that track's start (KBC-066 FR-9). */
  private readonly askedTrack = toSignal(
    this.route.queryParamMap.pipe(map((params) => trackFromParam(params))),
    { initialValue: null },
  );

  /**
   * An address that is no media id (`/midia/fila`) is a media not found: the API would refuse
   * it as invalid (400), which reads as a question that could not be sent.
   */
  private readonly malformedId = computed(
    () => this.id() !== '' && !mediaIdSchema.safeParse(this.id()).success,
  );
  protected readonly item = httpResource(
    () => (this.id() && !this.malformedId() ? mediaUrl(this.id()) : undefined),
    { parse: (body) => mediaItemSchema.parse(body) },
  );
  protected readonly media = computed<MediaItem | null>(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  protected readonly ready = computed(() => {
    const current = this.media();
    return current?.status === 'ready' && !current.archived;
  });
  /** "faixa 3 de 12" (KBC-068 FR-4); nothing once it left the edit. */
  protected readonly trackPlace = computed(() => {
    const parent = this.media()?.parent;
    if (!parent || parent.ordinal === null) return '';
    return $localize`:@@tracks.place:faixa ${parent.ordinal}:ordinal: de ${parent.total}:total:`;
  });
  /** The recording at the start of the track (`?t=`, KBC-038 FR-5). */
  protected readonly contextParams = computed(() => ({
    t: Math.floor((this.media()?.parent?.startMs ?? 0) / 1000),
  }));
  /** "Vozes" is for whoever edits recordings (KBC-064 BR-2, AC-2), once signed in. */
  protected readonly canEdit = computed(
    () =>
      this.session.me() !== null &&
      this.session.can('media-edit') &&
      !this.media()?.parent,
  );
  /** "Editar", "Ajustar início e fim", "Apagar faixa" (KBC-073 AC-14). */
  protected readonly canEditTrack = computed(
    () =>
      this.session.me() !== null &&
      this.session.can('media-edit') &&
      !!this.media()?.parent,
  );
  /** A track's subjects and summary, for who listens with `media-subjects` (KBC-070). */
  protected readonly canReadAbout = computed(
    () =>
      this.session.me() !== null &&
      this.session.can('media-subjects') &&
      this.session.can('media-tracks') &&
      !!this.media()?.parent,
  );
  /** A track's subjects, for who classifies (KBC-069 scope). */
  protected readonly canSeeSubjects = computed(
    () =>
      this.session.me() !== null &&
      this.session.can('media-classify') &&
      !this.canReadAbout() &&
      !!this.media()?.parent,
  );
  /** Where the preparation is, for whoever edits (T20, AC-17). */
  private readonly edit = httpResource(
    () =>
      this.canEdit() && this.ready() ? mediaEditUrl(this.id()) : undefined,
    { parse: (body) => mediaEditSchema.parse(body) },
  );
  protected readonly editLink = computed(() => editPagePath(this.id()));
  protected readonly prepareLink = computed(() =>
    preparationPagePath(this.id()),
  );
  /** What the entry to T20 says: nothing until the edit is known. */
  protected readonly editEntry = computed(() => {
    if (!this.edit.hasValue()) return null;
    const { started, status, step, approvedTracks, preparationStep } =
      this.edit.value();
    if (status === 'approved')
      return { state: 'approved' as const, step, tracks: approvedTracks };
    if (preparationStep)
      return { state: 'paused' as const, step: preparationStep };
    if (started) return { state: 'paused' as const, step };
    return { state: 'new' as const, step };
  });
  protected readonly appliedText = computed(() => {
    const entry = this.editEntry();
    const count = entry?.state === 'approved' ? entry.tracks : 0;
    return count === 1
      ? $localize`:@@tracks.entry.appliedOne:1 faixa aplicada`
      : $localize`:@@tracks.entry.applied:${count}:count: faixas aplicadas`;
  });
  /**
   * Who speaks is for everyone who may listen (KBC-151 BR-0): the API sends confirmed names
   * only, and the separation only to whoever names the voices (KBC-065 BR-3, ADR 0032).
   */
  protected readonly canSeeSpeakers = computed(
    () => this.session.me() !== null,
  );
  /** "Mostrar quem fala" (FR-4): on by default. */
  protected readonly speakersOn = computed(
    () => this.canSeeSpeakers() && this.preferences.speakersOn(),
  );
  protected readonly status = computed(() => {
    const media = this.media();
    return media ? statusTextOf(media) : '';
  });
  /** Where the transcription is (KBC-036); the low notice says it apart (BR-5). */
  protected readonly transcription = computed(() => {
    const media = this.media();
    if (!media) return '';
    const done = media.transcription.status === 'done';
    return done && isLowConfidence(media)
      ? ''
      : transcriptionTextOf(media, this.locale);
  });
  /** The current transcript's version, once there is one (KBC-038). */
  private readonly transcriptVersion = computed(() => {
    const media = this.media();
    return media?.status === 'ready' ? media.transcription.version : null;
  });
  protected readonly hasTranscript = computed(
    () => this.transcriptVersion() !== null,
  );
  protected readonly collapsed = this.preferences.transcriptCollapsed;
  /** "Destacar palavra a palavra" (KBC-045), kept in the account. */
  protected readonly wordHighlight = computed(
    () => this.listening.value().wordHighlight,
  );
  /** The subtitles' names come from the transcript, even with its column hidden (FR-4). */
  private readonly wantsTranscript = computed(
    () =>
      !this.collapsed() || (this.preferences.captionsOn() && this.speakersOn()),
  );
  protected readonly transcript = httpResource(
    () =>
      this.wantsTranscript() ? this.requestFor(mediaTranscriptUrl) : undefined,
    { parse: (body) => mediaTranscriptSchema.parse(body) },
  );
  private readonly subtitles = httpResource.text(() =>
    this.preferences.captionsOn()
      ? this.requestFor(mediaSubtitlesUrl)
      : undefined,
  );
  private readonly parsedCues = computed(() =>
    this.subtitles.hasValue() ? parseWebVtt(this.subtitles.value()) : [],
  );
  protected readonly cues = computed(() =>
    this.speakersOn() && this.transcript.hasValue()
      ? cuesWithSpeakers(this.parsedCues(), this.transcript.value())
      : this.parsedCues(),
  );
  /** The recording has approved tracks: "Faixas" is one of the views. */
  protected readonly hasTracks = computed(
    () => this.tracks.tracks().length > 0,
  );
  /** The view chosen; back on the transcript for each media opened. */
  protected readonly chosenView = linkedSignal<string, PlayerView>({
    source: this.id,
    computation: () => 'transcript',
  });
  /**
   * The view shown: the one chosen while it is still offered, else the transcript (the
   * tracks went away, or the person may no longer edit), so a chip is always selected.
   */
  protected readonly view = computed((): PlayerView => {
    const chosen = this.chosenView();
    if (chosen === 'tracks' && !this.hasTracks()) return 'transcript';
    if (chosen === 'voices' && !this.canEdit()) return 'transcript';
    return chosen;
  });
  /** The transcript is the body now: its own low-confidence notice is in view (BR-2). */
  protected readonly transcriptInView = computed(
    () => this.showTranscript() && this.view() === 'transcript',
  );
  /** The situation's pill: done in green, a failure in red, the rest in waiting. */
  protected readonly transcriptionTone = computed((): Tone => {
    // Transcribing again keeps a transcript: blue, as its banner (pill 'Retranscrevendo').
    if (this.waitingFor() && this.hasTranscript()) return 'info';
    const status = this.media()?.transcription.status;
    if (status === 'done') return 'ok';
    if (status === 'failed') return 'err';
    return status === 'none' || status === undefined ? 'muted' : 'warn';
  });
  /** The header's tint is the cover's colour (player.js P_TINT), not the collection's. */
  protected readonly pageTint = computed(() => {
    // Not found: the panel keeps the colour of what plays (pScreen o.notFound).
    // A track wears its recording's cover, and so its colour (player.js: "Parte de").
    const media = this.media();
    const title =
      media?.parent?.title ?? media?.title ?? this.engine.source()?.title;
    if (this.failedMedia()) return NEUTRAL_COVER[0];
    return title ? coverGradient(title)[0] : null;
  });
  /** A media that failed is grey: its cover and the header (player.js AC, "Falhou"). */
  protected readonly failedMedia = computed(
    () => this.media()?.status === 'failed',
  );
  protected readonly neutralCover = NEUTRAL_COVER;
  /** The author's avatar (pageHeader o.by): the initials on the name's own colour. */
  protected readonly authorInitials = computed(() =>
    coverCode(this.media()?.author?.name ?? ''),
  );
  protected readonly authorTint = computed(() => {
    const name = this.media()?.author?.name;
    return name ? coverGradient(name)[0] : null;
  });
  /** Under the title in the phone's ⋯ sheet: "Irmã Helena Prado · Alquimia Prática". */
  protected readonly sheetWhere = computed(() =>
    [this.media()?.author?.name, this.collectionTitle()]
      .filter(Boolean)
      .join(' · '),
  );
  /** "Áudio · Alquimia Prática": the kind and the collection it is in (v2 header). */
  protected readonly kicker = computed(() => {
    const collection = this.collectionTitle();
    const kind = $localize`:@@media.kicker:Áudio`;
    return collection ? `${kind} · ${collection}` : kind;
  });
  private readonly collectionTitle = computed(() => {
    const slug = this.media()?.topic;
    return this.topics().find((topic) => topic.slug === slug)?.title ?? '';
  });
  /** The full-screen player's head (phone): "Tocando do acervo · Alquimia Prática". */
  protected readonly playingFrom = computed(() => {
    const parent = this.media()?.parent;
    if (!parent) return $localize`:@@player.playingFrom:Tocando do acervo`;
    const place = this.trackPlace();
    const partOf = $localize`:@@player.playingFromTrack:Parte de`;
    return place ? `${partOf} · ${place}` : partOf;
  });
  protected readonly playingWhere = computed(
    () => this.media()?.parent?.title ?? this.collectionTitle(),
  );
  /** The media has bookmarks of the person: the mark is filled (v2 player). */
  private readonly bookmarksStore = inject(BookmarksStore);
  protected readonly bookmarked = computed(
    () => this.bookmarksStore.bookmarks().length > 0,
  );
  /** A new transcription waits or runs while the current text stays (T21, "na fila"). */
  protected readonly queuedNotice = computed(() => {
    const media = this.media();
    if (!media || media.status !== 'ready') return '';
    const { status, version } = media.transcription;
    const pending = status === 'waiting' || status === 'transcribing';
    return pending && version !== null ? this.transcription() : '';
  });
  /**
   * Waiting for the transcriber (pBody o.waiting, the queued banner): the title, and since
   * when it is off, or that none is paired, as a sentence under it. Null otherwise.
   */
  private readonly waitingFor = computed(() => {
    const media = this.media();
    return media ? waitingWordsOf(media, this.locale) : null;
  });
  /** The header's pill: where the transcription is, short while it waits. */
  protected readonly pillText = computed(
    () => this.waitingFor()?.pill ?? this.transcription(),
  );
  protected readonly pillWhy = computed(() => this.waitingFor()?.why ?? '');
  /** The empty transcript's title: where the transcription is ("Aguardando o transcritor"). */
  protected readonly waitingTitle = computed(
    () =>
      this.waitingFor()?.title ||
      this.transcription() ||
      $localize`:@@transcript.none:Ainda sem transcrição`,
  );
  /** Under it: since when the transcriber is off, and when the text comes. */
  protected readonly waitingText = computed(() => {
    const waiting = this.waitingFor();
    const later = $localize`:@@transcript.notYet:A transcrição aparece aqui quando ficar pronta.`;
    if (!waiting?.off) return later;
    const offline = this.media()?.transcription.transcriber === 'off';
    return `${waiting.off} ${offline ? $localize`:@@player.transcriptWhenBack:A transcrição aparece aqui quando ele voltar.` : later}`;
  });
  /** The queued banner (T21): its title, and what stays meanwhile. */
  protected readonly queuedTitle = computed(
    () => this.waitingFor()?.title || this.queuedNotice(),
  );
  protected readonly queuedText = computed(() => {
    const off = this.waitingFor()?.off;
    const keep = $localize`:@@media.transcribing.keep:O texto atual continua até a nova versão ficar pronta.`;
    return off ? `${off} ${keep}` : keep;
  });
  /** On a phone a banner or the track bar shares the screen: the cover gets smaller. */
  protected readonly compactCover = computed(
    () =>
      this.hasTracks() ||
      this.lowConfidence() ||
      this.lowCaptions() ||
      !!this.queuedNotice(),
  );
  private readonly desktopQuery =
    inject(DOCUMENT).defaultView?.matchMedia?.(DESKTOP_QUERY) ?? null;
  protected readonly desktop = signal(this.desktopQuery?.matches ?? true);
  private readonly rightPanel = inject(RightPanel);
  private readonly panelTabs = inject(PlayerPanelTabs);
  private readonly again = viewChild(TranscribeAgain);
  private readonly trackActions = viewChild(TrackActions);
  private readonly groq = viewChild(TranscribeWithGroq);
  /** The page's actions at the top of the player's ⋯ (v2: they were loose buttons). */
  protected readonly pageOptions = computed<readonly MenuOption[]>(() => {
    const media = this.media();
    if (!media) return [];
    return [
      ...this.trackOptions(),
      ...this.editOptions(media),
      ...this.phoneViewOptions(),
      ...(this.hasTranscript()
        ? [
            {
              id: 'transcript',
              icon: this.collapsed() ? ('eye' as const) : ('eyeOff' as const),
              label: this.collapsed()
                ? $localize`:@@transcript.show:Mostrar transcrição`
                : $localize`:@@transcript.hide:Esconder transcrição`,
            },
          ]
        : []),
    ];
  });

  /** A track's own editing (KBC-073): "Ajustar início e fim" is in the row, the rest here. */
  private trackOptions(): MenuOption[] {
    if (!this.trackActions()?.editable()) return [];
    return [
      // A phone has no room for the link in its row (pMobile): it waits here.
      ...(this.desktop()
        ? []
        : [
            {
              id: 'track-bounds',
              icon: 'scissors' as const,
              label: $localize`:@@trackEdit.bounds:Ajustar início e fim`,
            },
          ]),
      {
        id: 'track-edit',
        icon: 'edit',
        label: $localize`:@@trackEdit.editItem:Editar faixa`,
      },
      {
        id: 'track-history',
        icon: 'clock',
        label: $localize`:@@trackEdit.historyItem:Histórico da faixa`,
      },
      {
        id: 'track-delete',
        icon: 'trash',
        label: $localize`:@@trackEdit.delete:Apagar faixa`,
        danger: true,
      },
    ];
  }

  /** The recording's editing, at the top of ⋯ (v2): edit, prepare, transcribe again. */
  private editOptions(media: MediaItem): MenuOption[] {
    const options: MenuOption[] = [];
    if (media.canEdit)
      options.push({ id: 'edit', icon: 'edit', label: this.editLabel });
    if (this.editEntry()?.state === 'new')
      options.push({
        id: 'prepare',
        icon: 'scissors',
        label: $localize`:@@prep.entry.new:Preparar áudio`,
      });
    if (media.canTranscribeAgain)
      options.push({
        id: 'again',
        icon: 'refresh',
        label: $localize`:@@transcribeAgain.open:Transcrever de novo`,
      });
    if (media.canUseGroq)
      options.push({
        id: 'groq',
        icon: 'cpu',
        label: $localize`:@@groqItem.open:Transcrever com Groq`,
      });
    return options;
  }

  /** The full-screen player has no view chips (pMobile): its views wait in ⋯. */
  private phoneViewOptions(): MenuOption[] {
    if (this.desktop()) return [];
    const options: MenuOption[] = [];
    if (this.hasTracks() && this.view() !== 'tracks')
      options.push({
        id: 'view-tracks',
        icon: 'list',
        label: $localize`:@@player.view.tracksItem:Ver faixas`,
      });
    if (this.canEdit() && this.view() !== 'voices')
      options.push({
        id: 'view-voices',
        icon: 'people',
        label: $localize`:@@player.view.voicesItem:Ver vozes`,
      });
    return options;
  }
  /** The column shows: there is a transcript and the person did not hide it (FR-9). */
  protected readonly showTranscript = computed(
    () => this.hasTranscript() && !this.collapsed(),
  );
  protected readonly transcriptError = computed(() => {
    const err = this.transcript.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  /** The player's short notice with the subtitles: the column may be out of sight (BR-2). */
  protected readonly lowCaptions = computed(() => {
    const media = this.media();
    return media !== null && isLowConfidence(media) && this.showTranscript();
  });
  /**
   * The low-confidence notice in the header: when the transcript column does not show it
   * (hidden, or not loaded), so it is in view wherever the text or subtitles are (BR-2).
   */
  protected readonly lowConfidence = computed(() => {
    const media = this.media();
    const ready = media !== null && media.status === 'ready';
    const inColumn = this.showTranscript() && this.transcript.hasValue();
    return ready && isLowConfidence(media) && !inColumn;
  });
  protected readonly duration = computed(() => {
    const ms = this.media()?.durationMs;
    return ms === null || ms === undefined ? '' : formatDuration(ms);
  });
  protected readonly loadError = computed(() => {
    if (this.malformedId()) return errorMessage('MEDIA_NOT_FOUND');
    const err = this.item.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  /** Removed, not visible to this person, or no media id at all: nothing to try again. */
  protected readonly notFound = computed(() => {
    if (this.malformedId()) return true;
    const err = this.item.error();
    return err !== undefined && toUiErrorCode(err) === 'MEDIA_NOT_FOUND';
  });
  /** Where "Continuar de" would start, for the media opened now. */
  private readonly offer = signal<number | null>(null);
  /** The person chose ("Continuar de" or "Começar do início"): the offer goes. */
  private readonly answered = linkedSignal({
    source: this.offer,
    computation: () => false,
  });
  /** Offered until the person chooses or the media plays some other way (▶, K). */
  protected readonly resumeAt = computed(() =>
    this.answered() || this.engine.hasPlayed() ? null : this.offer(),
  );
  protected readonly resumeLabel = computed(() => {
    const at = this.resumeAt();
    return at === null
      ? ''
      : $localize`:@@player.resume:Continuar de ${formatClock(at)}:time:`;
  });
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  /** Opened from "Meus marcadores": plays from that bookmark (KBC-042 FR-5). */
  private playFrom = playFromOf(
    inject(Router).currentNavigation()?.extras.state,
  );
  private readonly backToList =
    viewChild<ElementRef<HTMLAnchorElement>>('backToList');
  private readonly editButton =
    viewChild<ElementRef<HTMLButtonElement>>('editButton');
  private readonly player = viewChild(MediaPlayer);
  /** The edit dialog was opened from ⋯: closing it gives the focus back there. */
  private editFromMenu = false;

  /**
   * "Ver marcadores" of a library row (v2 media-library-row-menu) opens here with
   * `#marcadores`: once the page is in, the focus (and the view) go to its bookmarks — on a
   * desktop in the Sobre tab of the panel beside the page, which renders a moment later.
   */
  private followBookmarksLink(): void {
    toObservable(this.ready)
      .pipe(
        filter(Boolean),
        take(1),
        filter(() => this.route.snapshot.fragment === 'marcadores'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.panelTabs.tab.set('about');
        afterNextRender(() => this.focusBookmarks(FOCUS_TRIES), {
          injector: this.injector,
        });
      });
  }

  private focusBookmarks(tries: number): void {
    const heading =
      this.host.querySelector<HTMLElement>('app-bookmark-list h3') ??
      this.document.querySelector<HTMLElement>('app-bookmark-list h3');
    if (!heading) {
      const view = this.document.defaultView;
      if (tries > 0 && view)
        view.requestAnimationFrame(() => this.focusBookmarks(tries - 1));
      return;
    }
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }

  constructor() {
    this.followBookmarksLink();
    inject(CollectionHeading).follow(
      computed<HeadingScope | null>(() => {
        const slug = this.media()?.topic;
        return slug ? { kind: 'topic', slug } : null;
      }),
    );
    toObservable(this.media)
      .pipe(
        filter((media): media is MediaItem => media?.status === 'ready'),
        distinctUntilChanged((a, b) => a.id === b.id),
        takeUntilDestroyed(),
      )
      .subscribe((media) => this.openWithTracks(media));
    this.pollWhileConverting();
    this.checkItemOnPlaybackError();
    // The lock screen and the status region follow the engine from now on (FR-7, FR-10).
    inject(MediaSessionAdapter);
    inject(PlayerAnnouncer);
    this.followPlayback();
    this.showAbout();
    this.destroyRef.onDestroy(() => {
      // Playing, it goes on in the mini-player; paused, leaving closes it (FR-8).
      if (!this.engine.playingOrAsked() && !this.engine.busy())
        this.engine.unload();
    });
  }

  /** The page shows what was saved at once; playback does not notice (AC-1). */
  protected edited({ after }: MediaEdited): void {
    this.item.set(after);
    this.announcement.set(detailsSavedText());
  }

  /** A change on a track: what listeners see of it now; the player is left alone (AC-5). */
  protected trackChanged(item: MediaItem | null): void {
    if (item) this.item.set(item);
    else this.item.reload();
  }

  /** Safari leaves a clicked button unfocused, so the dialog has nothing to give back. */
  protected editClosed(): void {
    this.editing.set(false);
    if (this.editFromMenu) this.player()?.focusMore();
    else this.editButton()?.nativeElement.focus();
    this.editFromMenu = false;
  }

  /** A page action chosen in the player's ⋯. */
  protected choosePageAction(id: string): void {
    if (id === 'edit') {
      this.editFromMenu = true;
      this.editing.set(true);
    }
    if (id === 'prepare') void this.router.navigateByUrl(this.prepareLink());
    if (id === 'transcript') this.toggleTranscript();
    if (id === 'view-tracks') this.chosenView.set('tracks');
    if (id === 'track-bounds') {
      const link = this.trackActions()?.boundsLink();
      if (link) void this.router.navigateByUrl(link);
    }
    if (id === 'track-edit') this.trackActions()?.openEdit();
    if (id === 'track-history') this.trackActions()?.openHistory();
    if (id === 'track-delete') this.trackActions()?.openDelete();
    if (id === 'view-voices') this.chosenView.set('voices');
    if (id === 'again') this.again()?.ask();
    if (id === 'groq') this.groq()?.ask();
  }

  private readonly aboutPart = viewChild('about', { read: ElementRef });

  /** The phone's "Sobre este áudio" button: that part of the page comes into view. */
  protected scrollToAbout(): void {
    const about = this.aboutPart()?.nativeElement as HTMLElement | undefined;
    about?.scrollIntoView({ block: 'start' });
    about?.querySelector<HTMLElement>('h3')?.focus();
  }

  /** A dialog opened from ⋯ closed: the focus goes back there (WCAG 2.4.3). */
  protected focusMore(): void {
    this.player()?.focusMore();
  }

  /** "Continuar de 23:10": plays from where the person stopped. */
  protected resume(): void {
    this.answered.set(true);
    this.engine.play();
  }

  /** "Esconder transcrição" / "Mostrar transcrição", remembered for every media. */
  protected toggleTranscript(): void {
    this.preferences.setTranscriptCollapsed(!this.collapsed());
  }

  /** The version is in the query, so a new transcript is fetched, not taken from cache. */
  private requestFor(url: (id: string) => string) {
    const version = this.transcriptVersion();
    return version === null
      ? undefined
      : { url: url(this.id()), params: { v: version } };
  }

  protected reloadTranscript(): void {
    this.transcript.reload();
  }

  /** "Vozes" shows a new separation: the transcript reads its voices again (KBC-064 FR-5). */
  protected readVoicesOf(version: number): void {
    if (!this.transcript.hasValue()) return;
    if (this.transcript.value().speakers?.version !== version)
      this.transcript.reload();
  }

  /** "Começar do início". */
  protected startOver(): void {
    this.answered.set(true);
    this.engine.seek(0);
    this.engine.play();
  }

  /**
   * "Sobre este áudio" (bookmarks, tracks, voices, the author) is the shell's right panel on
   * a desktop, beside the page, as in the v2 frame; on a phone it follows the page inline.
   * It goes with the page.
   */
  private showAbout(): void {
    const query = this.desktopQuery;
    if (query) {
      const onChange = (event: MediaQueryListEvent) =>
        this.desktop.set(event.matches);
      query.addEventListener('change', onChange);
      this.destroyRef.onDestroy(() =>
        query.removeEventListener('change', onChange),
      );
    }
    const about = computed(() => {
      const media = this.media();
      return this.desktop() && media && this.ready()
        ? { media, canEdit: this.canEdit() }
        : null;
    });
    toObservable(about)
      .pipe(takeUntilDestroyed())
      .subscribe((inputs) => this.openAbout(inputs));
    this.destroyRef.onDestroy(() => this.closeAbout());
  }

  /** The media whose Sobre the panel shows; a new one opens on Sobre. */
  private aboutShown: string | null = null;

  private openAbout(
    inputs: { media: MediaItem; canEdit: boolean } | null,
  ): void {
    // A reload of the same media keeps the tab chosen.
    if (inputs && inputs.media.id !== this.aboutShown)
      this.panelTabs.tab.set('about');
    this.aboutShown = inputs?.media.id ?? null;
    if (!inputs) return this.closeAbout();
    this.rightPanel.open({
      component: PlayerPanel,
      inputs,
      width: 'narrow',
      label: $localize`:@@player.about:Sobre este áudio`,
    });
  }

  private closeAbout(): void {
    if (this.rightPanel.content()?.component === PlayerPanel)
      this.rightPanel.close();
  }

  /** The tab's title says it plays ("▶ "), and the choice goes once playback starts. */
  private followPlayback(): void {
    effect(() => {
      const media = this.media();
      if (!media) return;
      const title = $localize`:@@route.mediaItemTitle:${media.title}:title: — Nova Alexandria`;
      this.title.setTitle(this.engine.playing() ? `▶ ${title}` : title);
    });
  }

  /** "Ela aparece aqui assim que estiver pronta" (T15): the page asks again meanwhile. */
  private pollWhileConverting(): void {
    const every = computed(() => {
      const media = this.media();
      return media ? pollEveryOf([media], this.pollMs) : null;
    });
    toObservable(every)
      .pipe(
        distinctUntilChanged(),
        switchMap((ms) => (ms === null ? EMPTY : interval(ms))),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.item.reload());
  }

  /**
   * The audio failed: the item may have been removed (or access taken away) while it
   * played. Asking for it again tells "não encontrada" from a connection problem.
   */
  private checkItemOnPlaybackError(): void {
    toObservable(this.engine.playback)
      .pipe(
        map((playback) => playback.phase === 'error'),
        distinctUntilChanged(),
        filter(Boolean),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.item.reload());
    toObservable(this.notFound)
      .pipe(filter(Boolean), takeUntilDestroyed())
      .subscribe(() => {
        // Only what is gone stops: another media playing goes on in the bar (pScreen
        // o.notFound keeps the player bar).
        if (this.engine.source()?.id === this.id()) this.engine.unload();
        this.keepFocusOnPage();
      });
  }

  /** The player is gone: a focus left on <body> goes to the way out (NG-30). */
  private keepFocusOnPage(): void {
    afterNextRender(
      () => {
        if (this.document.activeElement === this.document.body)
          this.backToList()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected reload(): void {
    this.item.reload();
  }

  /** A subject chip: the search filtered by it, texts and audio (KBC-070). */
  protected searchSubject(name: string): void {
    const topic = this.media()?.topic;
    if (topic) this.chat.selectTopic(topic);
    this.views.select('search');
    this.chat.ask(name, {
      filters: { ...EMPTY_FILTERS, concepts: [name] },
      kinds: SEARCH_KINDS,
      origin: 'suggestion',
    });
    void this.router.navigateByUrl('/');
  }

  /** The tracks come first when the link names one; else they never hold the player. */
  private openWithTracks(media: MediaItem): void {
    const asked = this.askedTrack();
    if (asked === null) this.open(media);
    this.tracks
      .load(media.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tracks) => {
        if (asked !== null) this.open(media, tracks[asked - 1]?.startMs);
      });
  }

  /**
   * Loads the media paused at the saved position (this browser's unsent one when no other
   * device saved since, FR-3). Coming back from the mini-player keeps what plays.
   */
  private open(media: MediaItem, trackStartMs?: number): void {
    const playFrom = this.playFrom;
    this.playFrom = null;
    const startAt = trackStartMs ?? this.startAt();
    if (this.isLoaded(media)) {
      if (playFrom !== null) this.playAt(playFrom);
      else if (startAt !== null) this.engine.seek(startAt);
      return;
    }
    if (playFrom === null && startAt !== null) {
      // A link to a minute: positioned there, paused (no autoplay), no "Continuar de".
      this.saver.startFrom(media);
      this.engine.load(this.sourceOf(media), startAt);
      return;
    }
    if (playFrom !== null) {
      // The person chose where to listen from: no "Continuar de".
      this.saver.startFrom(media);
      this.engine.load(this.sourceOf(media), playFrom);
      this.playAt(playFrom);
      return;
    }
    const at = resumeFrom(this.saver.startFrom(media), media.durationMs);
    this.offer.set(at);
    this.engine.load(this.sourceOf(media), at ?? 0);
  }

  /** Who still plays an older cut stays on it; paused, the next opening takes the new one. */
  private isLoaded(media: MediaItem): boolean {
    const loaded = this.engine.source();
    if (loaded?.id !== media.id) return false;
    return (
      this.engine.playing() || loaded.fileVersion === media.parent?.fileVersion
    );
  }

  private playAt(ms: number): void {
    this.answered.set(true);
    this.engine.seek(ms);
    this.engine.play();
  }

  private sourceOf(media: MediaItem) {
    return {
      id: media.id,
      title: media.title,
      src: mediaStreamUrl(media.id, media.parent?.fileVersion),
      durationMs: media.durationMs,
      artist: media.author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
      ...(media.parent ? { fileVersion: media.parent.fileVersion } : {}),
      ...(media.hidden ? { hidden: media.hidden } : {}),
    };
  }
}

/** The track a link names, 1-based; null without a usable `?track=`. */
function trackFromParam(params: ParamMap): number | null {
  const track = Number(params.get('track'));
  return Number.isInteger(track) && track >= 1 ? track : null;
}

/** A bookmark's position from the navigation state, when it is one. */
function playFromOf(state: Record<string, unknown> | undefined): number | null {
  const ms = state?.['playFromMs'];
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

import { DOCUMENT, DatePipe } from '@angular/common';
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
  mediaEditSchema,
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
import { TranscriptPreferences } from '@core/media/transcript-preferences.js';
import { TracksStore } from '@core/media/tracks-store.js';
import { editPagePath, mediaEditUrl } from '@core/media/media-edit-api.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import {
  EMPTY,
  distinctUntilChanged,
  filter,
  interval,
  map,
  switchMap,
} from 'rxjs';
import {
  pollEveryOf,
  isLowConfidence,
  statusTextOf,
  transcriptionTextOf,
} from './media-labels.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { detailsSavedText, editDetailsLabel } from './edit-labels.js';
import { EditMediaDialog, type MediaEdited } from './edit-media-dialog.js';
import { hasLibrary } from './library/library-access.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { BookmarkList } from './bookmark-list.js';
import { MediaPlayer } from './player/media-player.js';
import { cuesWithSpeakers } from './voices/speaker-names.js';
import { VoicesPanel } from './voices/voices-panel.js';
import { PlayerShortcuts } from './player/player-shortcuts.js';
import { TranscribeAgain } from './transcribe-again.js';
import { TranscriptPanel } from './transcript/transcript-panel.js';
import { TrackNavList } from './tracks/track-nav-list.js';

/**
 * One media item (screens.md T15): its title, authorship and length, and the player once
 * it is ready. Opening it never plays (KBC-041 BR-3): with a saved position it offers
 * "Continuar de" and "Começar do início". Leaving it while it plays keeps it playing in
 * the mini-player (FR-8); leaving it paused stops it.
 */
@Component({
  selector: 'app-media-player-page',
  imports: [
    RouterLink,
    DatePipe,
    AuthorshipBadge,
    MediaPlayer,
    BookmarkList,
    EditMediaDialog,
    TranscribeAgain,
    TranscriptPanel,
    VoicesPanel,
    TrackNavList,
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
  private readonly preferences = inject(TranscriptPreferences);
  /** The collections the person sees, for "Editar informações" (KBC-050). */
  protected readonly topics = inject(ChatStore).topicList;
  protected readonly editLabel = editDetailsLabel();
  protected readonly editing = signal(false);
  protected readonly announcement = signal('');
  private readonly tracks = inject(TracksStore);
  private readonly id = toSignal(
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

  protected readonly item = httpResource(
    () => (this.id() ? mediaUrl(this.id()) : undefined),
    { parse: (body) => mediaItemSchema.parse(body) },
  );
  protected readonly media = computed<MediaItem | null>(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  protected readonly ready = computed(() => this.media()?.status === 'ready');
  /** "Vozes" is for whoever edits recordings (KBC-064 BR-2, AC-2), once signed in. */
  protected readonly canEdit = computed(
    () => this.session.me() !== null && this.session.can('media-edit'),
  );
  /** Where the preparation is, for whoever edits (T20, AC-17). */
  private readonly edit = httpResource(
    () =>
      this.canEdit() && this.ready() ? mediaEditUrl(this.id()) : undefined,
    { parse: (body) => mediaEditSchema.parse(body) },
  );
  protected readonly editLink = computed(() => editPagePath(this.id()));
  /** What the entry to T20 says: nothing until the edit is known. */
  protected readonly editEntry = computed(() => {
    if (!this.edit.hasValue()) return null;
    const { started, status, step, approvedTracks } = this.edit.value();
    if (status === 'approved')
      return { state: 'approved' as const, step, tracks: approvedTracks };
    if (started) return { state: 'paused' as const, step };
    // Dividing goes by the words: a new edit starts from a transcribed recording (T20).
    return this.hasTranscript() ? { state: 'new' as const, step } : null;
  });
  protected readonly appliedText = computed(() => {
    const entry = this.editEntry();
    const count = entry?.state === 'approved' ? entry.tracks : 0;
    return count === 1
      ? $localize`:@@tracks.entry.appliedOne:1 faixa aplicada`
      : $localize`:@@tracks.entry.applied:${count}:count: faixas aplicadas`;
  });
  /** Who speaks is for `media-speakers`, and for whoever names the voices (KBC-065 BR-4). */
  protected readonly canSeeSpeakers = computed(
    () =>
      this.session.me() !== null &&
      (this.session.can('media-speakers') || this.session.can('media-edit')),
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
    const err = this.item.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  /** Removed, or not visible to this person: nothing to try again. */
  protected readonly notFound = computed(() => {
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

  constructor() {
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
    this.destroyRef.onDestroy(() => {
      // Playing, it goes on in the mini-player; paused, leaving closes it (FR-8).
      if (!this.engine.playing() && !this.engine.busy()) this.engine.unload();
    });
  }

  /** The page shows what was saved at once; playback does not notice (AC-1). */
  protected edited({ after }: MediaEdited): void {
    this.item.set(after);
    this.announcement.set(detailsSavedText());
  }

  /** Safari leaves a clicked button unfocused, so the dialog has nothing to give back. */
  protected editClosed(): void {
    this.editing.set(false);
    this.editButton()?.nativeElement.focus();
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
        this.engine.unload();
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
    if (this.engine.source()?.id === media.id) {
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

  private playAt(ms: number): void {
    this.answered.set(true);
    this.engine.seek(ms);
    this.engine.play();
  }

  private sourceOf(media: MediaItem) {
    return {
      id: media.id,
      title: media.title,
      src: mediaStreamUrl(media.id),
      durationMs: media.durationMs,
      artist: media.author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
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

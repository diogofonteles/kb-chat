import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
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
import { ActivatedRoute, RouterLink } from '@angular/router';
import { mediaItemSchema, type MediaItem } from '@kb-chat/contracts';
import { formatClock, formatDuration, resumeFrom } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { MediaSessionAdapter } from '@core/media/media-session.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { mediaStreamUrl, mediaUrl } from '@core/media/media-api.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import {
  EMPTY,
  distinctUntilChanged,
  filter,
  interval,
  map,
  switchMap,
} from 'rxjs';
import { isInFlight, statusTextOf } from './media-labels.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { MediaPlayer } from './player/media-player.js';
import { PlayerShortcuts } from './player/player-shortcuts.js';

/**
 * One media item (screens.md T15): its title, authorship and length, and the player once
 * it is ready. Opening it never plays (KBC-041 BR-3): with a saved position it offers
 * "Continuar de" and "Começar do início". Leaving it while it plays keeps it playing in
 * the mini-player (FR-8); leaving it paused stops it.
 */
@Component({
  selector: 'app-media-player-page',
  imports: [RouterLink, DatePipe, AuthorshipBadge, MediaPlayer],
  templateUrl: './media-player-page.html',
  styleUrl: './media-player-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'shortcuts.handle($event)' },
})
export class MediaPlayerPage {
  private readonly engine = inject(MediaEngine);
  private readonly saver = inject(ProgressSaver);
  protected readonly shortcuts = inject(PlayerShortcuts);
  private readonly title = inject(Title);
  private readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => params.get('id') ?? ''),
    ),
    { initialValue: '' },
  );

  protected readonly item = httpResource(
    () => (this.id() ? mediaUrl(this.id()) : undefined),
    { parse: (body) => mediaItemSchema.parse(body) },
  );
  protected readonly media = computed<MediaItem | null>(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  protected readonly ready = computed(() => this.media()?.status === 'ready');
  protected readonly status = computed(() => {
    const media = this.media();
    return media ? statusTextOf(media) : '';
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
  private readonly injector = inject(Injector);
  private readonly backToList =
    viewChild<ElementRef<HTMLAnchorElement>>('backToList');

  constructor() {
    toObservable(this.media)
      .pipe(
        filter((media): media is MediaItem => media?.status === 'ready'),
        distinctUntilChanged((a, b) => a.id === b.id),
        takeUntilDestroyed(),
      )
      .subscribe((media) => this.open(media));
    this.pollWhileConverting();
    this.checkItemOnPlaybackError();
    // The lock screen and the status region follow the engine from now on (FR-7, FR-10).
    inject(MediaSessionAdapter);
    inject(PlayerAnnouncer);
    this.followPlayback();
    inject(DestroyRef).onDestroy(() => {
      // Playing, it goes on in the mini-player; paused, leaving closes it (FR-8).
      if (!this.engine.playing() && !this.engine.busy()) this.engine.unload();
    });
  }

  /** "Continuar de 23:10": plays from where the person stopped. */
  protected resume(): void {
    this.answered.set(true);
    this.engine.play();
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
    const converting = computed(() => {
      const media = this.media();
      return media !== null && isInFlight(media);
    });
    toObservable(converting)
      .pipe(
        distinctUntilChanged(),
        switchMap((moving) => (moving ? interval(this.pollMs) : EMPTY)),
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
        if (document.activeElement === document.body)
          this.backToList()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected reload(): void {
    this.item.reload();
  }

  /**
   * Loads the media paused at the saved position (this browser's unsent one when no other
   * device saved since, FR-3). Coming back from the mini-player keeps what plays.
   */
  private open(media: MediaItem): void {
    if (this.engine.source()?.id === media.id) return;
    const at = resumeFrom(this.saver.startFrom(media), media.durationMs);
    this.offer.set(at);
    this.engine.load(
      {
        id: media.id,
        title: media.title,
        src: mediaStreamUrl(media.id),
        durationMs: media.durationMs,
        artist: AUTHORSHIP_LABELS[media.authorship],
      },
      at ?? 0,
    );
  }
}

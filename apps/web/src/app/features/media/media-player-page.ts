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
  inject,
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
import { formatDuration } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MediaEngine } from '@core/media/media-engine.js';
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

/**
 * One media item (screens.md T15): its title, authorship and length, and the player once
 * it is ready. Opening it never plays (KBC-041 BR-3); leaving it stops the audio until the
 * mini-player of KBC-041 keeps it going.
 */
@Component({
  selector: 'app-media-player-page',
  imports: [RouterLink, DatePipe, AuthorshipBadge, MediaPlayer],
  templateUrl: './media-player-page.html',
  styleUrl: './media-player-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPlayerPage {
  private readonly engine = inject(MediaEngine);
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
    inject(DestroyRef).onDestroy(() => this.engine.unload());
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

  private open(media: MediaItem): void {
    this.title.setTitle(
      $localize`:@@route.mediaItemTitle:${media.title}:title: — Nova Alexandria`,
    );
    if (this.engine.source()?.id === media.id) return;
    this.engine.load({
      id: media.id,
      title: media.title,
      src: mediaStreamUrl(media.id),
    });
  }
}

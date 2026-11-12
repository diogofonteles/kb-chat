import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  mediaItemSchema,
  mediaTranscriptSchema,
  type MediaHit,
  type MediaItem,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { speak } from '@core/i18n/spoken-time.js';
import { MediaEngine } from '@core/media/media-engine.js';
import {
  mediaStreamUrl,
  mediaTranscriptUrl,
  mediaUrl,
} from '@core/media/media-api.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { textParts } from '@core/text/text-parts.js';
import { distinctUntilChanged, filter } from 'rxjs';
import { MediaPlayer } from '../player/media-player.js';
import { TranscriptPanel } from '../transcript/transcript-panel.js';
import { playbackStartOf, type PassageFocus } from './passage-focus.js';

interface Target {
  readonly media: MediaItem;
  readonly focus: PassageFocus;
}

const sameTarget = (a: Target, b: Target): boolean =>
  a.media.id === b.media.id && a.focus.startMs === b.focus.startMs;

/**
 * A spoken passage opened from the results (KBC-039 FR-3, FR-6, screens.md T2/T15): in
 * the reading panel, where texts open, the player plays from 2 s before the passage, with
 * the passage itself shown marked, and KBC-038's transcript below with the passage painted.
 */
@Component({
  selector: 'app-passage-panel',
  imports: [AuthorshipBadge, MediaPlayer, RouterLink, TranscriptPanel],
  templateUrl: './passage-panel.html',
  styleUrl: './passage-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'dialog',
    'aria-modal': 'false',
    '[attr.aria-labelledby]': '"passage-title"',
    '(keydown.escape)': 'closed.emit()',
  },
})
export class PassagePanel {
  readonly passage = input.required<MediaHit>();
  readonly closed = output();

  private readonly engine = inject(MediaEngine);
  private readonly saver = inject(ProgressSaver);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly heading =
    viewChild.required<ElementRef<HTMLHeadingElement>>('heading');

  protected readonly item = httpResource(
    () => mediaUrl(this.passage().mediaId),
    { parse: (body) => mediaItemSchema.parse(body) },
  );
  private readonly media = computed(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  /** What KBC-038's transcript panel paints: this segment of this media. */
  protected readonly focus = computed((): PassageFocus => ({
    mediaId: this.passage().mediaId,
    startMs: this.passage().startMs,
    endMs: this.passage().endMs,
  }));
  /** A whole track reached by its subject (KBC-070): no passage to mark. */
  protected readonly byTopic = computed(
    () => this.passage().match === 'subject',
  );
  protected readonly clock = computed(() =>
    formatClock(this.passage().startMs),
  );
  protected readonly spokenClock = computed(() =>
    speak(this.passage().startMs),
  );
  protected readonly parts = computed(() =>
    textParts(this.passage().text, this.passage().highlights),
  );
  protected readonly low = computed(() => this.passage().confidence === 'low');
  /** "Abrir na página da mídia", at the passage's second (`?t=`, KBC-038 FR-5). */
  protected readonly pageQuery = computed(() => ({
    t: Math.floor(playbackStartOf(this.passage()) / 1000),
  }));
  protected readonly ready = computed(() => this.media()?.status === 'ready');
  /**
   * The current transcript, once the audio is ready; the version in the query fetches a
   * new one instead of the cache (as the media page does). Without it the passage above
   * still shows what was found.
   */
  protected readonly transcript = httpResource(
    () => {
      const media = this.media();
      const version = media?.transcription.version ?? null;
      return media?.status === 'ready' && version !== null
        ? { url: mediaTranscriptUrl(media.id), params: { v: version } }
        : undefined;
    },
    { parse: (body) => mediaTranscriptSchema.parse(body) },
  );
  protected readonly loadError = computed(() => {
    const err = this.item.error();
    if (!err) return '';
    return toUiErrorCode(err) === 'MEDIA_NOT_FOUND'
      ? $localize`:@@passage.gone:Esta mídia não está mais disponível.`
      : errorMessage(toUiErrorCode(err));
  });

  constructor() {
    const target = computed((): Target | null => {
      const media = this.media();
      const focus = this.focus();
      return media?.status === 'ready' && media.id === focus.mediaId
        ? { media, focus }
        : null;
    });
    toObservable(target)
      .pipe(
        filter((one): one is Target => one !== null),
        distinctUntilChanged(sameTarget),
        takeUntilDestroyed(),
      )
      .subscribe((one) => this.play(one));
    // A new passage brings the reader to the top, on its title (as a document does).
    afterRenderEffect(() => {
      this.focus();
      this.host.scrollTop = 0;
      this.heading().nativeElement.focus({ preventScroll: true });
    });
  }

  protected reload(): void {
    this.item.reload();
  }

  /** Plays from 2 s before the passage: the person asked for that minute (T15). */
  private play({ media, focus }: Target): void {
    const at = playbackStartOf(focus);
    if (this.engine.source()?.id !== media.id) {
      this.saver.startFrom(media);
      this.engine.load(
        {
          id: media.id,
          title: media.title,
          src: mediaStreamUrl(media.id, media.parent?.fileVersion),
          durationMs: media.durationMs,
          artist: media.author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
          ...(media.parent ? { fileVersion: media.parent.fileVersion } : {}),
          ...(media.hidden ? { hidden: media.hidden } : {}),
        },
        at,
      );
    }
    this.engine.seek(at);
    this.engine.play();
  }
}

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
  type AnswerSource,
  type MediaItem,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { toUiErrorCode } from '@core/api/api-error.js';
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
import { passageOf } from '@features/answer/answer-format.js';
import { distinctUntilChanged, filter } from 'rxjs';
import { MediaPlayer } from '../player/media-player.js';
import {
  playbackStartOf,
  type PassageFocus,
} from '../search-hit/passage-focus.js';
import { TranscriptPanel } from '../transcript/transcript-panel.js';

interface Target {
  readonly media: MediaItem;
  readonly startMs: number;
}

/** Codes that say the track is not there for this person: one message for all (PD-07). */
const GONE_CODES: readonly string[] = [
  'MEDIA_NOT_FOUND',
  'FORBIDDEN',
  'NOT_FOUND',
];

const sameTarget = (a: Target, b: Target): boolean =>
  a.media.id === b.media.id && a.startMs === b.startMs;

/**
 * "Trecho da faixa" (KBC-099, T22): a track cited by the research opens in the reading panel
 * on the passage the answer cites, from media.db's current transcript, highlighted and
 * scrolled into view, with the track's player beside it 2 s before, paused. Nothing plays
 * by itself (FR-8); the vault's Markdown is never shown (ADR 0035 §7).
 */
@Component({
  selector: 'app-track-passage-panel',
  imports: [AuthorshipBadge, MediaPlayer, RouterLink, TranscriptPanel],
  templateUrl: './track-passage-panel.html',
  styleUrl: './track-passage-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'dialog',
    'aria-modal': 'false',
    '[attr.aria-label]': 'dialogLabel()',
    '(keydown.escape)': 'closed.emit()',
  },
})
export class TrackPassagePanel {
  readonly source = input.required<AnswerSource>();
  /** The time the citation wrote ("" for a plain [n] or the chip). */
  readonly at = input('');
  readonly closed = output();

  private readonly engine = inject(MediaEngine);
  private readonly saver = inject(ProgressSaver);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly heading =
    viewChild.required<ElementRef<HTMLHeadingElement>>('heading');

  protected readonly mediaId = computed(
    () => this.source().media?.mediaId ?? '',
  );
  protected readonly item = httpResource(() => mediaUrl(this.mediaId()), {
    parse: (body) => mediaItemSchema.parse(body),
  });
  private readonly media = computed(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  /** The cited passage, exact from media.db; null for an answer saved before KBC-099. */
  private readonly passage = computed(() =>
    passageOf(this.source(), this.at()),
  );
  /** What the transcript paints and scrolls to; none without a resolved passage. */
  protected readonly focus = computed((): PassageFocus | null => {
    const passage = this.passage();
    return passage
      ? {
          mediaId: this.mediaId(),
          startMs: passage.startMs,
          endMs: passage.endMs,
        }
      : null;
  });
  private readonly startMs = computed(() => this.passage()?.startMs ?? 0);
  protected readonly clock = computed(() => formatClock(this.startMs()));
  protected readonly spokenClock = computed(() => speak(this.startMs()));
  /** "Trecho da faixa O que é o ritmo?, aos 41 segundos" (AC-12). */
  protected readonly dialogLabel = computed(() =>
    this.passage()
      ? $localize`:@@trackPassage.label:Trecho da faixa ${this.source().title}:title:, aos ${this.spokenClock()}:clock:`
      : $localize`:@@trackPassage.labelStart:Trecho da faixa ${this.source().title}:title:`,
  );
  /** "Palestra de 12/03/2017 · faixa 3 de 12". */
  protected readonly recordingLine = computed(() => {
    const media = this.source().media;
    if (!media) return '';
    const place =
      media.ordinal && media.total
        ? $localize`:@@trackPassage.place: · faixa ${media.ordinal}:ordinal: de ${media.total}:total:`
        : '';
    return `${media.recordingTitle}${place}`;
  });
  protected readonly low = computed(
    () => this.source().media?.confidence === 'low',
  );
  /** "Abrir na página da faixa", at 2 s before the passage (`?t=`, KBC-038 FR-5). */
  protected readonly pageQuery = computed(() => ({
    t: Math.floor(playbackStartOf({ startMs: this.startMs() }) / 1000),
  }));
  protected readonly ready = computed(() => this.media()?.status === 'ready');
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
  /** Archived, deleted or out of reach: one sentence, the same for all (PD-07). */
  protected readonly gone = computed(() => {
    const err = this.item.error();
    return err !== undefined && GONE_CODES.includes(toUiErrorCode(err));
  });
  protected readonly loadError = computed(() => {
    if (!this.item.error()) return '';
    return this.gone()
      ? $localize`:@@trackPassage.gone:Esta faixa não está mais disponível.`
      : $localize`:@@trackPassage.failed:Não foi possível abrir a faixa.`;
  });

  constructor() {
    const target = computed((): Target | null => {
      const media = this.media();
      return media?.status === 'ready' && media.id === this.mediaId()
        ? { media, startMs: this.startMs() }
        : null;
    });
    toObservable(target)
      .pipe(
        filter((one): one is Target => one !== null),
        distinctUntilChanged(sameTarget),
        takeUntilDestroyed(),
      )
      .subscribe((one) => this.cue(one));
    // A new passage brings the reader to the top, on its title (T22 flow 1).
    afterRenderEffect(() => {
      this.focus();
      this.host.scrollTop = 0;
      this.heading().nativeElement.focus({ preventScroll: true });
    });
  }

  protected reload(): void {
    this.item.reload();
  }

  /** The player 2 s before the passage, paused, "Tocar" ready (FR-8, T22 flow 2). */
  private cue({ media, startMs }: Target): void {
    const at = playbackStartOf({ startMs });
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
        },
        at,
      );
      return;
    }
    this.engine.pause();
    this.engine.seek(at);
  }
}

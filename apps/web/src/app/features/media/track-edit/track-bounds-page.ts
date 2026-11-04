import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
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
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  editWordsSchema,
  mediaSilencesSchema,
  mediaWaveformSchema,
  trackEditViewSchema,
  type DraftTrack,
  type TrackNeighbour,
} from '@kb-chat/contracts';
import {
  NUDGE_MS,
  snapPointsOf,
  type TrackEdge,
} from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { mediaStreamUrl, mediaUrl } from '@core/media/media-api.js';
import { editWordsUrl, mediaWaveformUrl } from '@core/media/media-edit-api.js';
import {
  TrackRevisionsApi,
  trackEditUrl,
} from '@core/media/track-revisions-api.js';
import { EMPTY, distinctUntilChanged, interval, map, switchMap } from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import {
  TrackAudition,
  endRange,
  startRange,
} from '../tracks/track-audition.js';
import {
  TrackTimeline,
  type HandleMoved,
  type ListenKind,
} from '../tracks/track-timeline.js';
import { formatBoundary } from '../tracks/track-labels.js';
import { decodePeaks } from '../tracks/waveform-canvas.js';

/** The neighbours are blocks of the bar: `DraftTrack` is the shape it draws. */
const toDraft = (track: TrackNeighbour): DraftTrack => ({
  id: track.id,
  runId: null,
  source: 'manual',
  edited: true,
  firstSegment: null,
  lastSegment: null,
  startMs: track.startMs,
  endMs: track.endMs,
  kind: 'qa',
  title: track.title,
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
});

/**
 * "Ajustar início e fim" (KBC-073 FR-6): the bar of the recording's edit on one track, its
 * neighbours showing and limiting it (BR-5). Saving only asks for the cut: who listens goes on,
 * and the page says "Recortando…" until it lands (BR-3).
 */
@Component({
  selector: 'app-track-bounds-page',
  imports: [RouterLink, TrackTimeline],
  templateUrl: './track-bounds-page.html',
  styleUrls: ['./track-edit.css', './track-bounds-page.css'],
  providers: [TrackAudition],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackBoundsPage {
  private readonly api = inject(TrackRevisionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly timeline = viewChild(TrackTimeline);
  private readonly auditionElement =
    viewChild<ElementRef<HTMLAudioElement>>('auditionElement');
  protected readonly audition = inject(TrackAudition);

  protected readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((one) => one.get('id') ?? '')),
    { initialValue: '' },
  );
  protected readonly view = httpResource(() => trackEditUrl(this.id()), {
    parse: (body) => trackEditViewSchema.parse(body),
  });
  protected readonly current = computed(() =>
    this.view.hasValue() ? this.view.value() : null,
  );
  private readonly recordingId = computed(
    () => this.current()?.recordingId ?? '',
  );
  protected readonly streamUrl = computed(() =>
    this.recordingId() ? mediaStreamUrl(this.recordingId()) : '',
  );
  private readonly wordsRead = httpResource(
    () => (this.recordingId() ? editWordsUrl(this.recordingId()) : undefined),
    { parse: (body) => editWordsSchema.parse(body) },
  );
  private readonly silencesRead = httpResource(
    () =>
      this.recordingId()
        ? `${mediaUrl(this.recordingId())}/silences`
        : undefined,
    { parse: (body) => mediaSilencesSchema.parse(body) },
  );
  private readonly waveform = httpResource(
    () =>
      this.recordingId() ? mediaWaveformUrl(this.recordingId()) : undefined,
    { parse: (body) => mediaWaveformSchema.parse(body) },
  );

  protected readonly words = computed(() =>
    this.wordsRead.hasValue() ? this.wordsRead.value().words : [],
  );
  protected readonly snap = computed(() =>
    snapPointsOf(
      this.words().map(([startMs, endMs]) => ({ startMs, endMs })),
      this.silencesRead.hasValue() ? this.silencesRead.value().intervals : [],
    ),
  );
  protected readonly peaks = computed(() => {
    if (!this.waveform.hasValue()) return null;
    const { status, peaks } = this.waveform.value();
    return status === 'ready' ? decodePeaks(peaks) : null;
  });
  protected readonly peaksPerSecond = computed(() =>
    this.waveform.hasValue() ? this.waveform.value().peaksPerSecond : 10,
  );
  /** The bounds on screen, from the track's until a handle moves them. */
  protected readonly bounds = linkedSignal(() => {
    const track = this.current();
    return track ? { startMs: track.startMs, endMs: track.endMs } : null;
  });
  protected readonly numbered = computed(() => {
    const track = this.current();
    const bounds = this.bounds();
    if (!track || !bounds) return [];
    return track.tracks.map((one) => ({
      ordinal: one.ordinal,
      track: toDraft(one.id === track.mediaId ? { ...one, ...bounds } : one),
    }));
  });
  protected readonly selected = computed(
    () => this.numbered().find((one) => one.track.id === this.id()) ?? null,
  );
  protected readonly cursorMs = linkedSignal(() => this.bounds()?.startMs ?? 0);
  protected readonly edge = signal<TrackEdge>('start');
  protected readonly timesText = computed(() => {
    const bounds = this.bounds();
    if (!bounds) return '';
    const start = formatBoundary(bounds.startMs);
    const end = formatBoundary(bounds.endMs);
    return $localize`:@@trackEdit.times:Início ${start}:start: · Fim ${end}:end:`;
  });
  protected readonly cutting = computed(
    () => this.current()?.cut === 'running' || this.sending(),
  );
  protected readonly canSave = computed(() => {
    const track = this.current();
    const bounds = this.bounds();
    if (!track || !bounds || track.locked || this.cutting()) return false;
    return bounds.startMs !== track.startMs || bounds.endMs !== track.endMs;
  });
  private readonly sending = signal(false);
  private readonly saved = signal(false);
  protected readonly finished = computed(
    () => this.saved() && this.current()?.cut === 'none',
  );
  protected readonly failure = signal('');
  protected readonly loadError = computed(() => {
    const err = this.view.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });

  constructor() {
    afterRenderEffect((onCleanup) => {
      const element = this.auditionElement()?.nativeElement;
      if (element) this.audition.attach(element);
      onCleanup(() => this.audition.stop());
    });
    toObservable(computed(() => this.current()?.cut === 'running'))
      .pipe(
        distinctUntilChanged(),
        switchMap((on) => (on ? interval(this.pollMs) : EMPTY)),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.view.reload());
  }

  /** Only this track's handles exist here: a neighbour is a limit, not a choice. */
  protected ignoreOthers(): void {
    this.timeline()?.showAt(this.bounds()?.startMs ?? 0);
  }

  protected moveHandle({ edge, ms }: HandleMoved): void {
    this.saved.set(false);
    this.bounds.update(
      (bounds) =>
        bounds && {
          ...bounds,
          [edge === 'start' ? 'startMs' : 'endMs']: ms,
        },
    );
  }

  protected nudge(direction: 1 | -1): void {
    this.timeline()?.nudge(this.edge(), direction * NUDGE_MS);
  }

  protected listen(kind: ListenKind): void {
    const bounds = this.bounds();
    if (!bounds) return;
    if (kind === 'track' && this.audition.playing()) {
      this.audition.stop();
      return;
    }
    const ranges: Record<ListenKind, () => { fromMs: number; toMs: number }> = {
      track: () => ({ fromMs: bounds.startMs, toMs: bounds.endMs }),
      start: () => startRange(bounds.startMs),
      end: () => endRange(bounds.endMs),
    };
    this.audition.play(ranges[kind]());
  }

  protected save(): void {
    const track = this.current();
    const bounds = this.bounds();
    if (!track || !bounds) return;
    this.sending.set(true);
    this.failure.set('');
    this.api
      .moveBounds(track, bounds)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          this.sending.set(false);
          this.saved.set(true);
          this.view.set(view);
        },
        error: (err: unknown) => {
          this.sending.set(false);
          this.failure.set(errorMessage(toUiErrorCode(err)));
          this.view.reload();
        },
      });
  }
}

import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
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
  type TrackBoundsRequest,
  type TrackEditView,
  type TrackNeighbour,
} from '@kb-chat/contracts';
import { NUDGE_MS, snapPointsOf, type TrackEdge } from '@kb-chat/player-core';
import {
  errorDetailsOf,
  errorMessage,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { mediaStreamUrl, mediaUrl } from '@core/media/media-api.js';
import { editWordsUrl, mediaWaveformUrl } from '@core/media/media-edit-api.js';
import {
  TrackRevisionsApi,
  trackEditUrl,
} from '@core/media/track-revisions-api.js';
import {
  EMPTY,
  distinctUntilChanged,
  filter,
  interval,
  map,
  switchMap,
  type Observable,
} from 'rxjs';
import { z } from 'zod';
import {
  UiButton,
  UiChip,
  UiCover,
  UiIcon,
  UiPill,
  coverGradient,
} from '@ui/index.js';
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

/** Bounds the person moved, and the version they moved them from (BR-10). */
interface Adjustment {
  readonly bounds: TrackBoundsRequest;
  readonly version: number;
}

const cutRunningSchema = z.object({ reason: z.literal('cut-running') });

/** Refused because the version on screen is old, or a cut on the way changed it already. */
const isConflict = (err: unknown): boolean =>
  (err instanceof HttpErrorResponse && err.status === 412) ||
  cutRunningSchema.safeParse(errorDetailsOf(err)).success;

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
  level: null,
});

const timesOf = ({ startMs, endMs }: TrackBoundsRequest): string => {
  const start = formatBoundary(startMs);
  const end = formatBoundary(endMs);
  return $localize`:@@trackEdit.times:Início ${start}:start: · Fim ${end}:end:`;
};

/**
 * "Ajustar início e fim" (KBC-073 FR-6): the bar of the recording's edit on one track, its
 * neighbours showing and limiting it (BR-5). Saving only asks for the cut: who listens goes on,
 * and the page says "Recortando…" until it lands (BR-3).
 */
@Component({
  selector: 'app-track-bounds-page',
  imports: [
    RouterLink,
    TrackTimeline,
    UiButton,
    UiChip,
    UiCover,
    UiIcon,
    UiPill,
  ],
  templateUrl: './track-bounds-page.html',
  styleUrls: [
    './track-edit.css',
    '../preparation/prep-head.css',
    './track-bounds-page.css',
  ],
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
  /**
   * What the person moved: nothing read from the server takes it back, and a save names the
   * version it came from, so a reload can never turn it into a save over someone else's (BR-10).
   */
  private readonly adjusted = signal<Adjustment | null>(null);
  /** Each move's previous state, so "Desfazer" goes back one step (KBC-130 AC-5). */
  private readonly history = signal<readonly (Adjustment | null)[]>([]);
  /** The bounds on screen, from the track's until a handle moves them. */
  protected readonly bounds = computed((): TrackBoundsRequest | null => {
    const track = this.current();
    if (!track) return null;
    return (
      this.adjusted()?.bounds ?? { startMs: track.startMs, endMs: track.endMs }
    );
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
  /** The page's gradient: the colour of the recording's cover (prepare.js, PR_TINT). */
  protected readonly tint = computed(() => {
    const track = this.current();
    return track ? coverGradient(track.recordingTitle || track.title)[0] : null;
  });
  /** "Perguntas e respostas de 2019 · faixa 2 de 3" under the title. */
  protected readonly subText = computed(() => {
    const track = this.current();
    if (!track) return '';
    const ordinal = track.ordinal;
    const total = track.tracks.length;
    const which = $localize`:@@trackEdit.whichTrack:faixa ${ordinal}:ordinal: de ${total}:total:`;
    return track.recordingTitle ? `${track.recordingTitle} · ${which}` : which;
  });
  protected readonly startText = computed(() => {
    const bounds = this.bounds();
    return bounds ? formatBoundary(bounds.startMs) : '';
  });
  protected readonly endText = computed(() => {
    const bounds = this.bounds();
    return bounds ? formatBoundary(bounds.endMs) : '';
  });
  /** What the track says, on one line under the wave (prepare.js boundsMain). */
  protected readonly spoken = computed(() => {
    const bounds = this.bounds();
    if (!bounds) return '';
    return this.words()
      .filter(
        ([startMs]) => startMs >= bounds.startMs && startMs < bounds.endMs,
      )
      .map(([, , text]) => text)
      .join(' ');
  });
  /** The nudge that moved the edge in use away from the track's own, lit (prepare.js). */
  protected readonly lastNudge = computed((): 1 | -1 | 0 => {
    const track = this.current();
    const bounds = this.bounds();
    if (!track || !bounds) return 0;
    const delta =
      this.edge() === 'start'
        ? bounds.startMs - track.startMs
        : bounds.endMs - track.endMs;
    return delta > 0 ? 1 : delta < 0 ? -1 : 0;
  });
  /** The version on screen is old: the person says whose bounds go on first (BR-10). */
  protected readonly conflict = signal<TrackEditView | null>(null);
  protected readonly theirTimes = computed(() => {
    const theirs = this.conflict();
    return theirs ? timesOf(theirs) : '';
  });
  /** Nothing can go over a cut on its way: the choice opens when it lands. */
  protected readonly theirCutRunning = computed(
    () => this.conflict()?.cut === 'running',
  );
  protected readonly cutting = computed(
    () => this.current()?.cut === 'running' || this.sending(),
  );
  protected readonly cutFailed = computed(
    () => this.current()?.cut === 'failed' && !this.sending(),
  );
  /** A move that is not saved yet: "Não salvo · Desfazer". */
  protected readonly unsaved = computed(
    () => this.adjusted() !== null && this.history().length > 0,
  );
  /** The start moved from the track's own: it shows in green. */
  protected readonly startMoved = computed(() => {
    const track = this.current();
    const bounds = this.bounds();
    return !!track && !!bounds && bounds.startMs !== track.startMs;
  });
  protected readonly endMoved = computed(() => {
    const track = this.current();
    const bounds = this.bounds();
    return !!track && !!bounds && bounds.endMs !== track.endMs;
  });
  protected readonly canSave = computed(() => {
    const track = this.current();
    const bounds = this.bounds();
    if (!track || !bounds || track.locked || this.cutting()) return false;
    if (this.conflict()) return false;
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
    this.audition.followElement(this.auditionElement);
    toObservable(
      computed(
        () => this.current()?.cut === 'running' || this.theirCutRunning(),
      ),
    )
      .pipe(
        distinctUntilChanged(),
        switchMap((on) => (on ? interval(this.pollMs) : EMPTY)),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.refresh());
  }

  /** Only this track's handles exist here: a neighbour is a limit, not a choice. */
  protected ignoreOthers(): void {
    this.timeline()?.showAt(this.bounds()?.startMs ?? 0);
  }

  protected moveHandle({ edge, ms }: HandleMoved): void {
    const track = this.current();
    const bounds = this.bounds();
    if (!track || !bounds) return;
    this.saved.set(false);
    const before = this.adjusted();
    this.history.update((steps) => [...steps, before]);
    this.adjusted.update((mine) => ({
      version: mine?.version ?? track.version,
      bounds: { ...bounds, [edge === 'start' ? 'startMs' : 'endMs']: ms },
    }));
  }

  /** Back to the bounds before the last move. */
  protected undo(): void {
    const steps = this.history();
    if (steps.length === 0) return;
    this.history.set(steps.slice(0, -1));
    this.adjusted.set(steps[steps.length - 1] ?? null);
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
    const version = this.adjusted()?.version ?? track.version;
    this.send(this.api.moveBounds({ mediaId: track.mediaId, version }, bounds));
  }

  protected retryCut(): void {
    const track = this.current();
    if (track) this.send(this.api.retryCut(track));
  }

  protected useTheirs(theirs: TrackEditView): void {
    this.adopt(theirs);
    this.adjusted.set(null);
    this.history.set([]);
  }

  protected saveOver(theirs: TrackEditView): void {
    this.adopt(theirs);
    this.adjusted.update(
      (mine) => mine && { ...mine, version: theirs.version },
    );
    this.save();
  }

  private adopt(theirs: TrackEditView): void {
    this.view.set(theirs);
    this.conflict.set(null);
  }

  private send(request: Observable<TrackEditView>): void {
    this.sending.set(true);
    this.failure.set('');
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (view) => {
        this.sending.set(false);
        this.saved.set(true);
        this.adjusted.set(null);
        this.history.set([]);
        this.view.set(view);
      },
      error: (err: unknown) => this.refused(err),
    });
  }

  private refused(err: unknown): void {
    this.sending.set(false);
    if (isConflict(err)) {
      this.readTheirs().subscribe({
        next: (theirs) => this.conflict.set(theirs),
        error: (read: unknown) => this.fail(read),
      });
      return;
    }
    this.fail(err);
    this.view.reload();
  }

  private readTheirs(): Observable<TrackEditView> {
    return this.api.view(this.id()).pipe(takeUntilDestroyed(this.destroyRef));
  }

  /** The screen follows a cut; during a conflict that cut is hers, and the panel follows it. */
  private refresh(): void {
    if (!this.conflict()) {
      this.view.reload();
      return;
    }
    this.readTheirs()
      .pipe(filter(() => this.conflict() !== null))
      .subscribe({
        next: (theirs) => this.conflict.set(theirs),
        error: (read: unknown) => this.fail(read),
      });
  }

  private fail(err: unknown): void {
    this.failure.set(errorMessage(toUiErrorCode(err)));
  }
}

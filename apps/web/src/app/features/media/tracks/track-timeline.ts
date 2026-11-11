import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { DraftTrack, EditWord } from '@kb-chat/contracts';
import {
  HANDLE_JUMP_MS,
  NUDGE_MS,
  clampHandle,
  landHandle,
  limitsOf,
  neighbourPoint,
  type HandleLanding,
  type HandleLimits,
  type SnapPoints,
  type TrackEdge,
} from '@kb-chat/player-core';
import { drawPeaks } from './waveform-canvas.js';
import {
  edgeName,
  formatBoundary,
  speakBoundary,
  stopText,
} from './track-labels.js';

/** The detail around the selected track (screen spec: the track ± 30 s). */
const MARGIN_MS = 30_000;
const MIN_SPAN_MS = 5_000;
const ZOOM_STEP = 1.5;
/** The arrows on the detail. */
const CURSOR_STEP_MS = 1_000;
/** Past this many words in view the row says to zoom in: they would be unreadable. */
const MAX_WORDS_SHOWN = 150;
/** Two rows of words; a word that fits neither waits for more zoom. */
const WORD_ROWS = 2;
/** A character of the words' row, on average, with room between words. */
const CHAR_PX = 8;
const WORD_GAP_PX = 6;
/** A press that moved less than this is a tap, however a finger trembles (R-4). */
const TAP_SLOP_PX = 6;
/** Narrower than this, a block's number cannot be read. */
const MIN_NUMBERED_PX = 18;

export interface NumberedTrack {
  readonly track: DraftTrack;
  readonly ordinal: number;
}

export interface HandleMoved {
  readonly trackId: string;
  readonly edge: TrackEdge;
  readonly ms: number;
}

export type ListenKind = 'track' | 'start' | 'end';

interface ViewWindow {
  readonly startMs: number;
  readonly spanMs: number;
}

interface Drag {
  readonly edge: TrackEdge;
  readonly limits: HandleLimits;
  readonly ms: number;
  readonly stopText: string;
  /** Where the press began, and how far from the line: the target is 48 px wide. */
  readonly pressX: number;
  readonly grabMs: number;
  /** Past the slop: a tap moves nothing (UP-06). */
  readonly moved: boolean;
}

const isProposal = (track: DraftTrack) =>
  track.source === 'ai' && !track.edited;

/** The words that fit without touching, each on the first row with room for it. */
function placeWords<T extends { readonly px: number; readonly text: string }>(
  words: readonly T[],
): (T & { readonly row: number })[] {
  const freeFrom: number[] = Array.from({ length: WORD_ROWS }, () => -Infinity);
  return words.flatMap((word) => {
    const row = freeFrom.findIndex((free) => free <= word.px);
    if (row < 0) return [];
    freeFrom[row] = word.px + word.text.length * CHAR_PX + WORD_GAP_PX;
    return [{ ...word, row }];
  });
}

/**
 * The bar (screen spec T20): the whole recording in numbered blocks and the selected track's
 * detail, with the wave, the words and the two handles. A drag moves only the handle's own
 * styles, so it follows the finger whatever the length of the recording (NFR-1).
 */
@Component({
  selector: 'app-track-timeline',
  templateUrl: './track-timeline.html',
  styleUrl: './track-timeline.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackTimeline {
  readonly tracks = input.required<readonly NumberedTrack[]>();
  readonly selected = input.required<NumberedTrack | null>();
  readonly durationMs = input.required<number>();
  readonly peaks = input<Uint8Array | null>(null);
  readonly peaksPerSecond = input(10);
  readonly words = input<readonly EditWord[]>([]);
  readonly snap = input.required<SnapPoints>();
  /** Where "Nova faixa aqui" and "Dividir aqui" act. */
  readonly cursorMs = input.required<number>();
  /** What plays now, in the bar. */
  readonly playheadMs = input<number | null>(null);
  readonly readOnly = input(false);

  readonly selectTrack = output<string>();
  readonly moved = output<HandleMoved>();
  readonly cursorChange = output<number>();
  readonly listen = output<ListenKind>();
  /** The handle in use, for the fine adjustments beside it. */
  readonly edgeChange = output<TrackEdge>();

  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('wave');
  private readonly view = linkedSignal<string | undefined, ViewWindow>({
    source: () => this.selected()?.track.id,
    computation: () => this.windowAround(),
  });
  private readonly drag = signal<Drag | null>(null);
  private readonly width = signal(0);
  /**
   * The track as moved so far: a held key lands again before the input comes back from the
   * parent, and must not start from where the handle was (FR-4).
   */
  private readonly moving = linkedSignal(() => this.selected()?.track ?? null);
  private readonly pinch = new Map<number, number>();
  private pinchSpan: number | null = null;
  /** A handle was pressed: the click that ends it is not a click on the bar. */
  private handlePressed = false;
  /** Why the last move stopped, beside the handle (FR-3). */
  protected readonly stop = signal('');

  protected readonly blocks = computed(() => {
    const total = this.durationMs() || 1;
    return this.tracks().map(({ track, ordinal }) => ({
      id: track.id,
      ordinal,
      left: (track.startMs / total) * 100,
      width: ((track.endMs - track.startMs) / total) * 100,
      proposed: isProposal(track),
      active: track.id === this.selected()?.track.id,
      numbered: this.fitsNumber((track.endMs - track.startMs) / total),
    }));
  });
  protected readonly overviewWindow = computed(() => {
    const { startMs, spanMs } = this.view();
    const total = this.durationMs() || 1;
    return { left: (startMs / total) * 100, width: (spanMs / total) * 100 };
  });
  protected readonly detailBlocks = computed(() =>
    this.tracks()
      .filter(({ track }) => this.inView(track.startMs, track.endMs))
      .map(({ track, ordinal }) => {
        const active = track.id === this.selected()?.track.id;
        return {
          id: track.id,
          ordinal,
          active,
          proposed: isProposal(track),
          left: this.percent(active ? this.shownEdge('start') : track.startMs),
          rightGap:
            100 - this.percent(active ? this.shownEdge('end') : track.endMs),
        };
      }),
  );
  protected readonly handles = computed(() => {
    const selected = this.selected();
    if (!selected || this.readOnly()) return [];
    return (['start', 'end'] as const).map((edge) => {
      const ms = this.shownEdge(edge);
      const limits = this.limitsFor(edge);
      return {
        edge,
        name: edgeName(edge, selected.ordinal),
        left: this.percent(ms),
        inView: this.inView(ms, ms),
        min: Math.round(limits.minMs / 100) / 10,
        max: Math.round(limits.maxMs / 100) / 10,
        now: Math.round(ms / 100) / 10,
        text: `${edgeName(edge, selected.ordinal)}: ${speakBoundary(ms)}`,
      };
    });
  });
  protected readonly tag = computed(() => {
    const drag = this.drag();
    return drag
      ? { text: formatBoundary(drag.ms), left: this.percent(drag.ms) }
      : null;
  });
  protected readonly dragStop = computed(
    () => this.drag()?.stopText ?? this.stop(),
  );
  protected readonly visibleWords = computed(() => {
    const { startMs, spanMs } = this.view();
    const width = this.width();
    const shown = this.words().filter(
      ([from, to]) => to > startMs && from < startMs + spanMs,
    );
    if (shown.length > MAX_WORDS_SHOWN) return null;
    return placeWords(
      shown.map(([from, , text], index) => ({
        key: `${index}-${from}`,
        from,
        text,
        left: this.percent(from),
        px: (this.percent(from) / 100) * width,
      })),
    );
  });
  protected readonly ticks = computed(() => {
    const drag = this.drag();
    if (!drag) return [];
    const { startMs, spanMs } = this.view();
    return this.snap()
      [drag.edge].filter((ms) => ms >= startMs && ms <= startMs + spanMs)
      .slice(0, MAX_WORDS_SHOWN)
      .map((ms) => this.percent(ms));
  });
  protected readonly playhead = computed(() => {
    const ms = this.playheadMs();
    return ms === null ? null : this.percent(ms);
  });
  protected readonly cursor = computed(() => this.percent(this.cursorMs()));

  constructor() {
    afterRenderEffect((onCleanup) => {
      const element = this.detail()?.nativeElement;
      if (!element || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() =>
        this.width.set(element.clientWidth),
      );
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    });
    afterRenderEffect(() => {
      const canvas = this.canvas()?.nativeElement;
      const { startMs, spanMs } = this.view();
      const peaks = this.peaks();
      if (canvas && peaks)
        drawPeaks(canvas, {
          peaks,
          peaksPerSecond: this.peaksPerSecond(),
          startMs,
          spanMs,
        });
    });
  }

  zoomIn(): void {
    this.zoomTo(this.view().spanMs / ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomTo(this.view().spanMs * ZOOM_STEP);
  }

  /** The detail on `ms`, keeping the zoom. */
  showAt(ms: number): void {
    this.view.update(({ spanMs }) => ({
      startMs: this.clampStart(ms - spanMs / 2, spanMs),
      spanMs,
    }));
  }

  /** A fine adjustment, from the buttons or Alt+arrows (FR-4): never snaps. */
  nudge(edge: TrackEdge, deltaMs: number): void {
    const from = this.edgeOf(edge);
    this.commit(edge, clampHandle(from + deltaMs, this.limitsFor(edge)));
  }

  protected keydown(event: KeyboardEvent, edge: TrackEdge): void {
    const landing = this.keyLanding(event, edge);
    const listen = LISTEN_KEYS[event.key.toLowerCase()];
    if (landing) {
      event.preventDefault();
      event.stopPropagation();
      this.commit(edge, landing);
    } else if (listen && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      this.listen.emit(listen);
    }
  }

  private keyLanding(
    event: KeyboardEvent,
    edge: TrackEdge,
  ): HandleLanding | null {
    const limits = this.limitsFor(edge);
    const from = this.edgeOf(edge);
    if (event.key === 'Home') return clampHandle(limits.minMs, limits);
    if (event.key === 'End') return clampHandle(limits.maxMs, limits);
    const direction =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return null;
    if (event.altKey) return clampHandle(from + direction * NUDGE_MS, limits);
    if (event.shiftKey)
      return this.land(edge, from + direction * HANDLE_JUMP_MS);
    return this.wordLanding({ edge, from, direction });
  }

  /** `←/→`: to the next word edge; with no word that way, the handle stays. */
  private wordLanding(input: {
    edge: TrackEdge;
    from: number;
    direction: 1 | -1;
  }): HandleLanding {
    const { edge, from, direction } = input;
    const limits = this.limitsFor(edge);
    const points = this.snap()[edge];
    const target = neighbourPoint(from, { points, direction });
    return clampHandle(target ?? from, limits);
  }

  private land(edge: TrackEdge, toMs: number): HandleLanding {
    return landHandle(
      { toMs, edge },
      { limits: this.limitsFor(edge), snap: this.snap() },
    );
  }

  /** A landing where the handle already is changes nothing: no undo step, no "edited". */
  private commit(edge: TrackEdge, landing: HandleLanding): void {
    const trackId = this.selected()?.track.id;
    if (!trackId) return;
    this.stop.set(stopText(landing.stop));
    if (landing.ms === this.edgeOf(edge)) return;
    this.moving.update(
      (track) =>
        track && {
          ...track,
          [edge === 'start' ? 'startMs' : 'endMs']: landing.ms,
        },
    );
    this.moved.emit({ trackId, edge, ms: landing.ms });
    if (!this.inView(landing.ms, landing.ms)) this.showAt(landing.ms);
  }

  protected grab(event: PointerEvent, edge: TrackEdge): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.edgeChange.emit(edge);
    this.handlePressed = true;
    const ms = this.edgeOf(edge);
    this.drag.set({
      edge,
      limits: this.limitsFor(edge),
      ms,
      stopText: '',
      pressX: event.clientX,
      grabMs: this.msAt(event) - ms,
      moved: false,
    });
    this.stop.set('');
  }

  protected dragMove(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag) return;
    const moved =
      drag.moved || Math.abs(event.clientX - drag.pressX) >= TAP_SLOP_PX;
    if (!moved) return;
    const landing = clampHandle(this.msAt(event) - drag.grabMs, drag.limits);
    this.drag.set({
      ...drag,
      ms: landing.ms,
      stopText: stopText(landing.stop),
      moved,
    });
  }

  protected release(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag) return;
    event.stopPropagation();
    this.drag.set(null);
    if (drag.moved)
      this.commit(
        drag.edge,
        this.land(drag.edge, this.msAt(event) - drag.grabMs),
      );
  }

  protected cancelDrag(): void {
    this.drag.set(null);
  }

  /** Two fingers on the detail zoom it (UP-09: the buttons do the same). */
  protected touch(event: PointerEvent): void {
    this.handlePressed = false;
    if (event.pointerType !== 'touch') return;
    this.pinch.set(event.pointerId, event.clientX);
    this.pinchSpan = null;
  }

  protected touchMove(event: PointerEvent): void {
    if (!this.pinch.has(event.pointerId)) return;
    this.pinch.set(event.pointerId, event.clientX);
    if (this.pinch.size !== 2) return;
    const [a = 0, b = 0] = [...this.pinch.values()];
    const distance = Math.max(1, Math.abs(a - b));
    if (this.pinchSpan === null) {
      this.pinchSpan = this.view().spanMs * distance;
      return;
    }
    this.zoomTo(this.pinchSpan / distance);
  }

  protected touchEnd(event: PointerEvent): void {
    this.pinch.delete(event.pointerId);
    this.pinchSpan = null;
  }

  /** Safari ends a drag with a click on the bar, not on the handle that was held. */
  protected placeCursor(event: MouseEvent): void {
    if (this.handlePressed) {
      this.handlePressed = false;
      return;
    }
    const target = event.target;
    const block =
      target instanceof HTMLElement ? target.closest('[data-track]') : null;
    const id = block?.getAttribute('data-track');
    if (id && id !== this.selected()?.track.id) this.selectTrack.emit(id);
    this.cursorChange.emit(Math.round(this.msAt(event)));
  }

  /** The cursor by keyboard: where "Nova faixa aqui" and "Dividir aqui" act (AC-18). */
  protected cursorKey(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    const direction =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? HANDLE_JUMP_MS : CURSOR_STEP_MS;
    const ms = this.cursorMs() + direction * step;
    this.cursorChange.emit(Math.max(0, Math.min(ms, this.durationMs())));
  }

  protected placeAtWord(event: Event, ms: number): void {
    event.stopPropagation();
    this.cursorChange.emit(ms);
  }

  protected focusEdge(edge: TrackEdge): void {
    this.edgeChange.emit(edge);
  }

  protected chooseBlock(id: string): void {
    this.selectTrack.emit(id);
  }

  private zoomTo(wanted: number): void {
    const total = this.durationMs();
    const spanMs = Math.min(total, Math.max(MIN_SPAN_MS, wanted));
    this.view.update((now) => {
      const center = now.startMs + now.spanMs / 2;
      return { startMs: this.clampStart(center - spanMs / 2, spanMs), spanMs };
    });
  }

  /** Without a measure yet (or a layout, in a test) every block keeps its number. */
  private fitsNumber(share: number): boolean {
    const width = this.width();
    return width === 0 || share * width >= MIN_NUMBERED_PX;
  }

  private clampStart(startMs: number, spanMs: number): number {
    return Math.max(0, Math.min(startMs, this.durationMs() - spanMs));
  }

  private windowAround(): ViewWindow {
    const total = this.durationMs();
    const track = this.selected()?.track;
    if (!track) return { startMs: 0, spanMs: total };
    const startMs = Math.max(0, track.startMs - MARGIN_MS);
    const endMs = Math.min(total, track.endMs + MARGIN_MS);
    return { startMs, spanMs: endMs - startMs };
  }

  private plainTracks() {
    return this.tracks().map(({ track }) => track);
  }

  private limitsFor(edge: TrackEdge): HandleLimits {
    return limitsOf(this.plainTracks(), {
      trackId: this.selected()?.track.id ?? '',
      edge,
      durationMs: this.durationMs(),
    });
  }

  private edgeOf(edge: TrackEdge): number {
    const track = this.moving();
    if (!track) return 0;
    return edge === 'start' ? track.startMs : track.endMs;
  }

  private shownEdge(edge: TrackEdge): number {
    const drag = this.drag();
    return drag?.edge === edge ? drag.ms : this.edgeOf(edge);
  }

  private inView(fromMs: number, toMs: number): boolean {
    const { startMs, spanMs } = this.view();
    return toMs >= startMs && fromMs <= startMs + spanMs;
  }

  private percent(ms: number): number {
    const { startMs, spanMs } = this.view();
    return ((ms - startMs) / (spanMs || 1)) * 100;
  }

  private msAt(event: MouseEvent): number {
    const rect = this.detail()?.nativeElement.getBoundingClientRect();
    const { startMs, spanMs } = this.view();
    if (!rect || rect.width === 0) return startMs;
    return startMs + ((event.clientX - rect.left) / rect.width) * spanMs;
  }
}

/** With the focus on a handle (FR-5). */
const LISTEN_KEYS: Readonly<Record<string, ListenKind>> = {
  ' ': 'track',
  i: 'start',
  f: 'end',
};

import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { MediaTranscript } from '@kb-chat/contracts';
import {
  formatClock,
  highlightParts,
  lastStartedAt,
  minuteLink,
  prepareSearch,
  quoteWithLink,
  searchPrepared,
  type SearchHit,
  type TextPart,
} from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { mediaPagePath } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { PlaybackClock } from '@core/media/playback-clock.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { skip } from 'rxjs';

/** One segment as the list shows it. */
interface SegmentView {
  readonly index: number;
  readonly startMs: number;
  readonly clock: string;
  readonly label: string;
  readonly text: string;
  /** Only for a segment with occurrences of the search. */
  readonly parts: readonly TextPart[] | null;
}

/** A passage the person selected in the list, and where its first segment starts. */
interface Selected {
  readonly text: string;
  readonly startMs: number;
}

/** Keys that move between segments, and by how many (Home/End go to the ends). */
const STEPS: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  ArrowUp: -1,
  PageDown: 10,
  PageUp: -10,
};

/** Keys that move between occurrences in the search field (Enter too). */
const HIT_STEPS: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  ArrowUp: -1,
};

/** The active segment is kept within this share of the list from its top and bottom. */
const COMFORT = 0.15;

/**
 * The transcript beside the player (screens.md T15, KBC-038): the segment being heard is
 * marked (`aria-current`, background and side bar) and kept in view without stealing the
 * focus; any scrolling by the person stops that until "Voltar ao trecho atual", a segment
 * or a skip in the player. One Tab stop with ↑/↓, Home/End and Enter (FR-7), search
 * without accents (FR-8) and copying a selection with the minute's link (FR-9).
 */
@Component({
  selector: 'app-transcript-panel',
  templateUrl: './transcript-panel.html',
  styleUrl: './transcript-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The list's own events, taken here: a click anywhere on a segment plays it, and the
  // keys move between the time buttons (the buttons are what is focusable).
  host: {
    '(document:selectionchange)': 'readSelection()',
    '(click)': 'clickSegment($event)',
    '(keydown)': 'moveWithKeys($event)',
    '(wheel)': 'scrolledIn($event)',
    '(touchmove)': 'scrolledIn($event)',
    '(pointerdown)': 'pressList($event)',
  },
})
export class TranscriptPanel {
  readonly transcript = input.required<MediaTranscript>();
  /** The media's title, for "Copiar com o link do minuto". */
  readonly title = input.required<string>();

  private readonly engine = inject(MediaEngine);
  private readonly clock = inject(PlaybackClock);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly list = viewChild<ElementRef<HTMLOListElement>>('list');
  private readonly items = viewChildren<ElementRef<HTMLLIElement>>('item');
  private readonly times = viewChildren<ElementRef<HTMLButtonElement>>('time');

  protected readonly segments = computed(() => this.transcript().segments);
  protected readonly low = computed(
    () => this.transcript().confidence === 'low',
  );
  protected readonly activeIndex = computed(() =>
    lastStartedAt(this.segments(), this.clock.positionMs()),
  );
  /** Off once the person scrolls or moves through the list themselves (FR-3). */
  private readonly tracking = signal(true);
  protected readonly query = signal('');
  protected readonly searching = computed(() => this.query().trim() !== '');
  /** With the search open, the list does not follow either (FR-8). */
  protected readonly following = computed(
    () => this.tracking() && !this.searching(),
  );
  protected readonly showBackToCurrent = computed(
    () => !this.following() && this.activeIndex() >= 0,
  );
  /** The segment the person moved to with the keys; else the active one takes the Tab. */
  private readonly moved = signal<number | null>(null);
  protected readonly tabStop = computed(
    () => this.moved() ?? Math.max(0, this.activeIndex()),
  );

  /** The texts folded once per transcript: a keystroke only scans them (NFR-2). */
  private readonly searchable = computed(() =>
    prepareSearch(this.segments().map((segment) => segment.text)),
  );
  protected readonly hits = computed(() =>
    searchPrepared(this.searchable(), this.query()),
  );
  protected readonly currentHit = linkedSignal({
    source: this.hits,
    computation: () => 0,
  });
  protected readonly searchStatus = computed(() => {
    if (!this.searching()) return '';
    const count = this.hits().length;
    const query = this.query().trim();
    return count === 0
      ? $localize`:@@transcript.search.none:Nenhum trecho com '${query}:query:'.`
      : $localize`:@@transcript.search.count:${this.currentHit() + 1}:current: de ${count}:total:`;
  });
  /** The segments as listed, made once per transcript (labels and times). */
  private readonly plainView = computed<SegmentView[]>(() =>
    this.segments().map((segment, index) => ({
      index,
      startMs: segment.startMs,
      clock: formatClock(segment.startMs),
      label: $localize`:@@transcript.playFrom:Tocar de ${speak(segment.startMs)}:time:`,
      text: segment.text,
      parts: null,
    })),
  );
  /** Segments with occurrences get their highlighted parts; the others stay the same. */
  protected readonly view = computed<SegmentView[]>(() => {
    const plain = this.plainView();
    const marks = marksBySegment(this.hits(), this.currentHit());
    if (marks.size === 0) return plain;
    return plain.map((item) =>
      marks.has(item.index)
        ? {
            ...item,
            parts: highlightParts(item.text, marks.get(item.index) ?? []),
          }
        : item,
    );
  });
  protected readonly selected = signal<Selected | null>(null);

  constructor() {
    this.clock.watch(inject(DestroyRef));
    // A skip or a jump in the player brings the list back to what is heard (FR-3).
    toObservable(this.engine.seeksLanded)
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe(() => this.resumeTracking());
    afterRenderEffect(() => {
      const index = this.activeIndex();
      if (this.following() && index >= 0) this.reveal(index);
    });
    afterRenderEffect(() => {
      const hit = this.hits()[this.currentHit()];
      if (hit) this.reveal(hit.segment);
    });
  }

  /** Clicking a segment's time or text plays from it (FR-4); a selection is left alone. */
  protected clickSegment(event: MouseEvent): void {
    const index = this.segmentOf(event.target);
    // `detail` is 0 for Enter and Space on the time button: always a request to play.
    if (index === null || (event.detail > 0 && this.selected() !== null))
      return;
    this.playFrom(index);
  }

  /** ↑/↓, PageUp/PageDown, Home/End move the one Tab stop (FR-7); the list stops following. */
  protected moveWithKeys(event: KeyboardEvent): void {
    if (this.segmentOf(event.target) === null) return;
    const target = this.targetOf(event.key);
    if (target === null) return;
    event.preventDefault();
    this.tracking.set(false);
    this.moved.set(target);
    this.times()[target]?.nativeElement.focus();
  }

  /** Wheel or touch over the list: the person reads elsewhere (FR-3). */
  protected scrolledIn(event: Event): void {
    if (this.segmentOf(event.target) !== null || this.isList(event.target))
      this.stopFollowing();
  }

  /** A press on the list itself (not on a segment) is its scroll bar. */
  protected pressList(event: PointerEvent): void {
    if (this.isList(event.target)) this.stopFollowing();
  }

  /** "Voltar ao trecho atual": the active segment in view, with the focus (AC-3, AC-7). */
  protected backToCurrent(): void {
    this.resumeTracking();
    afterNextRender(
      () => {
        const index = this.activeIndex();
        this.reveal(index, 'instant');
        this.times()[index]?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected search(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }

  /** Enter/↓ next, Shift+Enter/↑ previous, Esc clears (FR-8). */
  protected searchKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.searching()) {
      event.preventDefault();
      this.query.set('');
      return;
    }
    const step =
      event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : HIT_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    this.stepHit(step);
  }

  protected stepHit(step: number): void {
    const count = this.hits().length;
    if (count > 0) this.currentHit.update((at) => (at + step + count) % count);
  }

  /** "Tocar daqui": the current occurrence's segment. */
  protected playHit(): void {
    const hit = this.hits()[this.currentHit()];
    if (hit) this.playFrom(hit.segment);
  }

  /** Keeps what is selected inside the list, for "Copiar com o link do minuto" (FR-9). */
  protected readSelection(): void {
    const selection = this.document.getSelection();
    const list = this.list()?.nativeElement;
    const range =
      selection && !selection.isCollapsed && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null;
    const text = selection?.toString().trim() ?? '';
    if (!range || !list?.contains(range.commonAncestorContainer) || !text) {
      this.selected.set(null);
      return;
    }
    this.selected.set({ text, startMs: startOfNode(range.startContainer) });
  }

  protected copySelection(): void {
    const selected = this.selected();
    const origin = this.document.location.origin;
    if (!selected) return;
    const link = minuteLink(
      origin + mediaPagePath(this.transcript().mediaId),
      selected.startMs,
    );
    const text = quoteWithLink({
      text: selected.text,
      title: this.title(),
      link,
    });
    this.copy(text);
  }

  private copy(text: string): void {
    const clipboard = this.document.defaultView?.navigator.clipboard;
    if (!clipboard) {
      this.say(COPY_FAILED());
      return;
    }
    // The browser's clipboard is a Promise API; both outcomes are said (TS-14).
    void clipboard.writeText(text).then(
      () =>
        this.say(
          $localize`:@@transcript.copied:Trecho copiado com o link do minuto.`,
        ),
      () => this.say(COPY_FAILED()),
    );
  }

  private stopFollowing(): void {
    this.tracking.set(false);
  }

  private isList(target: EventTarget | null): boolean {
    return target !== null && target === this.list()?.nativeElement;
  }

  /** The index of the segment an event happened in, when it is one of the list's. */
  private segmentOf(target: EventTarget | null): number | null {
    const list = this.list()?.nativeElement;
    if (!(target instanceof Element) || !list?.contains(target)) return null;
    const item = target.closest<HTMLElement>('[data-index]');
    return item ? Number(item.dataset['index']) : null;
  }

  private say(message: string): void {
    this.announcer.say(message);
  }

  private playFrom(index: number): void {
    const segment = this.segments()[index];
    if (!segment) return;
    this.resumeTracking();
    this.moved.set(index);
    this.engine.seek(segment.startMs);
    this.engine.play();
  }

  private resumeTracking(): void {
    this.tracking.set(true);
    this.moved.set(null);
  }

  private targetOf(key: string): number | null {
    const last = this.segments().length - 1;
    if (last < 0) return null;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    const step = STEPS[key];
    if (step === undefined) return null;
    return Math.min(last, Math.max(0, this.tabStop() + step));
  }

  /**
   * Scrolls only the list (never the page) so the segment sits in its upper third, unless
   * it is already comfortably in view; smooth unless reduced motion is asked.
   */
  private reveal(index: number, behavior: ScrollBehavior = 'smooth'): void {
    const list = this.list()?.nativeElement;
    const item = this.items()[index]?.nativeElement;
    if (!list || !item) return;
    const margin = list.clientHeight * COMFORT;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    const inView =
      top >= list.scrollTop + margin &&
      bottom <= list.scrollTop + list.clientHeight - margin;
    if (inView) return;
    const reduced =
      this.document.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? false;
    const target = Math.max(0, top - list.clientHeight / 3);
    if (typeof list.scrollTo === 'function')
      list.scrollTo({ top: target, behavior: reduced ? 'instant' : behavior });
    else list.scrollTop = target;
  }
}

const COPY_FAILED = () =>
  $localize`:@@transcript.copyFailed:Não consegui copiar. Copie o trecho à mão.`;

/** Each segment's occurrences, the current one told apart. */
function marksBySegment(
  hits: readonly SearchHit[],
  current: number,
): Map<number, { start: number; end: number; current: boolean }[]> {
  const marks = new Map<
    number,
    { start: number; end: number; current: boolean }[]
  >();
  hits.forEach((hit, index) =>
    marks.set(hit.segment, [
      ...(marks.get(hit.segment) ?? []),
      { start: hit.start, end: hit.end, current: index === current },
    ]),
  );
  return marks;
}

/** Where the segment holding `node` starts (its `data-start-ms`); 0 when outside one. */
function startOfNode(node: Node): number {
  const element = node instanceof Element ? node : node.parentElement;
  const item = element?.closest<HTMLElement>('[data-start-ms]');
  return Number(item?.dataset['startMs'] ?? 0);
}

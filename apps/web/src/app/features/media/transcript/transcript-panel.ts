import { DatePipe, DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  Renderer2,
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
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import type { MediaTranscript } from '@kb-chat/contracts';
import {
  formatClock,
  lastStartedAt,
  minuteLink,
  prepareSearch,
  quoteWithLink,
  searchPrepared,
  type SearchHit,
} from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { mediaPagePath } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { PlaybackClock } from '@core/media/playback-clock.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import type { PassageFocus } from '../search-hit/passage-focus.js';
import { Subject, debounceTime, distinctUntilChanged, merge, skip } from 'rxjs';
import { speakerChanges, type SpeakerShown } from '../voices/speaker-names.js';
import { VoiceTag } from '../voices/voice-tag.js';
import { SEARCH_HIGHLIGHTS } from './search-highlights.js';

/** One segment as the list shows it. */
interface SegmentView {
  readonly index: number;
  readonly startMs: number;
  readonly clock: string;
  readonly label: string;
  readonly text: string;
  /** Who speaks, on the first segment of each change of speaker (KBC-065 FR-4); else null. */
  readonly speaker: (SpeakerShown & { readonly voice: number }) | null;
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

/** The pause after typing before the transcript is searched (tests set 0). */
export const TRANSCRIPT_SEARCH_DEBOUNCE_MS = new InjectionToken<number>(
  'TRANSCRIPT_SEARCH_DEBOUNCE_MS',
  { providedIn: 'root', factory: () => 150 },
);

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
  imports: [DatePipe, VoiceTag],
  templateUrl: './transcript-panel.html',
  styleUrl: './transcript-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The list's own events, taken here: a click anywhere on a segment plays it, and the
  // keys move between the time buttons (the buttons are what is focusable).
  host: {
    '(click)': 'clickSegment($event)',
    '(keydown)': 'moveWithKeys($event)',
    '(pointerdown)': 'pressList($event)',
  },
})
export class TranscriptPanel {
  readonly transcript = input.required<MediaTranscript>();
  /** The media's title, for "Copiar com o link do minuto". */
  readonly title = input.required<string>();
  /** The passage opened from a search hit, painted over its segments (KBC-039 AC-10). */
  readonly passage = input<PassageFocus | null>(null);
  /** "Mostrar quem fala" (KBC-065 FR-4). */
  readonly showSpeakers = input(true);

  private readonly engine = inject(MediaEngine);
  private readonly clock = inject(PlaybackClock);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly list = viewChild<ElementRef<HTMLOListElement>>('list');
  private readonly items = viewChildren<ElementRef<HTMLLIElement>>('item');
  private readonly times = viewChildren<ElementRef<HTMLButtonElement>>('time');

  protected readonly segments = computed(() => this.transcript().segments);
  /** Masters only: the API sends it to no one else (KBC-040 FR-4). */
  protected readonly termList = computed(() => this.transcript().termList);
  protected readonly low = computed(
    () => this.transcript().confidence === 'low',
  );
  protected readonly activeIndex = computed(() =>
    lastStartedAt(this.segments(), this.clock.positionMs()),
  );
  /** Off once the person scrolls or moves through the list themselves (FR-3). */
  private readonly tracking = signal(true);
  /** What is in the search field now. */
  protected readonly typed = signal('');
  /** Enter and Esc apply the field at once, without waiting for the pause. */
  private readonly applied = new Subject<string>();
  /**
   * The query searched: the field once typing pauses (NFR-2: a keystroke does no work over
   * the 20 000 words), or at once on Enter/Esc.
   */
  protected readonly query = toSignal(
    merge(
      toObservable(this.typed).pipe(
        debounceTime(inject(TRANSCRIPT_SEARCH_DEBOUNCE_MS)),
      ),
      this.applied,
    ).pipe(distinctUntilChanged()),
    { initialValue: '' },
  );
  /** Typing stops the following at once (FR-8), before the search runs. */
  protected readonly searching = computed(() => this.typed().trim() !== '');
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
    if (this.query().trim() === '') return '';
    const count = this.hits().length;
    const query = this.query().trim();
    return count === 0
      ? $localize`:@@transcript.search.none:Nenhum trecho com '${query}:query:'.`
      : $localize`:@@transcript.search.count:${this.currentHit() + 1}:current: de ${count}:total:`;
  });
  /** The segments as listed, made once per transcript (labels and times). */
  protected readonly view = computed<SegmentView[]>(() => {
    const segments = this.segments();
    const changes = this.showSpeakers()
      ? speakerChanges(this.transcript())
      : new Map();
    return segments.map((segment, index) => ({
      index,
      startMs: segment.startMs,
      clock: formatClock(segment.startMs),
      // The name starts with the visible time, for voice control (WCAG 2.5.3).
      label: $localize`:@@transcript.playFromClock:${formatClock(segment.startMs)}:clock:, tocar de ${speak(segment.startMs)}:time:`,
      text: segment.text,
      speaker: changes.get(index) ?? null,
    }));
  });
  /** The segment of the current occurrence: its outline shows it in any browser. */
  protected readonly currentHitSegment = computed(
    () => this.hits()[this.currentHit()]?.segment ?? -1,
  );
  protected readonly selected = signal<Selected | null>(null);

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.clock.follow(() => true, destroyRef);
    this.listenPassively(destroyRef);
    // A skip or a jump in the player brings the list back to what is heard (FR-3).
    toObservable(this.engine.seeksLanded)
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe(() => this.resumeTracking());
    // Measure, then scroll: one layout per change, never a read after a write.
    afterRenderEffect({
      earlyRead: () => {
        const index = this.activeIndex();
        return this.following() && index >= 0
          ? this.scrollTargetOf(index)
          : null;
      },
      write: (target) => this.scrollList(target()),
    });
    afterRenderEffect({
      earlyRead: () => {
        const hit = this.hits()[this.currentHit()];
        return hit ? this.scrollTargetOf(hit.segment) : null;
      },
      write: (target) => this.scrollList(target()),
    });
    this.paintSearch(destroyRef);
    this.paintPassage(destroyRef);
  }

  /**
   * The found passage painted like the search (no DOM change). It reads neither the clock
   * nor the query, so playing and typing never repaint it (KBC-038 NFR-2).
   */
  private paintPassage(destroyRef: DestroyRef): void {
    const highlights = inject(SEARCH_HIGHLIGHTS);
    afterRenderEffect({
      write: () => {
        const passage = this.passage();
        const ranges =
          passage?.mediaId === this.transcript().mediaId
            ? this.passageIndexes(passage).flatMap((index) => {
                const range = this.segmentRange(index);
                return range ? [range] : [];
              })
            : [];
        highlights.show('transcript-passage', ranges);
      },
    });
    destroyRef.onDestroy(() => highlights.clear('transcript-passage'));
  }

  /** The segments a passage overlaps (a hit is one segment; times keep it robust). */
  private passageIndexes(passage: PassageFocus): number[] {
    return this.segments().flatMap((segment, index) =>
      segment.startMs < passage.endMs && segment.endMs > passage.startMs
        ? [index]
        : [],
    );
  }

  /** A segment's whole text, in its text node. */
  private segmentRange(index: number): Range | null {
    const node = this.textNodeOf(index);
    if (!node) return null;
    const range = this.document.createRange();
    range.selectNodeContents(node);
    return range;
  }

  private textNodeOf(index: number): Text | null {
    const node =
      this.items()[index]?.nativeElement.querySelector('.text')?.firstChild;
    return node instanceof Text ? node : null;
  }

  /** The occurrences painted over the text, the current one apart (no DOM change). */
  private paintSearch(destroyRef: DestroyRef): void {
    const highlights = inject(SEARCH_HIGHLIGHTS);
    afterRenderEffect({
      write: () => {
        const hits = this.hits();
        const current = this.currentHit();
        const ranges = hits.map((hit) => this.rangeOf(hit));
        highlights.show(
          'transcript-match',
          ranges.filter(
            (range, index): range is Range => !!range && index !== current,
          ),
        );
        const now = ranges[current];
        highlights.show('transcript-current', now ? [now] : []);
      },
    });
    destroyRef.onDestroy(() => {
      highlights.clear('transcript-match');
      highlights.clear('transcript-current');
    });
  }

  /** The text of an occurrence, in its segment's text node. */
  private rangeOf(hit: SearchHit): Range | null {
    const node = this.textNodeOf(hit.segment);
    if (!node) return null;
    const range = this.document.createRange();
    range.setStart(node, Math.min(hit.start, node.length));
    range.setEnd(node, Math.min(hit.end, node.length));
    return range;
  }

  /**
   * Wheel and touch only read where the person scrolls: passive, so scrolling never waits
   * for the page (no host binding offers that). The selection is read from the document.
   */
  private listenPassively(destroyRef: DestroyRef): void {
    const renderer = inject(Renderer2);
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const passive = { passive: true };
    const stops = [
      renderer.listen(host, 'wheel', (e: Event) => this.scrolledIn(e), passive),
      renderer.listen(
        host,
        'touchmove',
        (e: Event) => this.scrolledIn(e),
        passive,
      ),
      renderer.listen('document', 'selectionchange', () =>
        this.readSelection(),
      ),
    ];
    destroyRef.onDestroy(() => stops.forEach((stop) => stop()));
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
    const from = this.segmentOf(event.target);
    if (from === null) return;
    // From the segment with the focus, not the one playing (it may have moved on).
    const target = this.targetOf(event.key, from);
    if (target === null) return;
    event.preventDefault();
    this.tracking.set(false);
    this.moved.set(target);
    this.times()[target]?.nativeElement.focus();
  }

  /** Wheel or touch over the list: the person reads elsewhere (FR-3). */
  private scrolledIn(event: Event): void {
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
      this.typed.set(event.target.value);
  }

  /**
   * Enter/↓ next, Shift+Enter/↑ previous, Esc clears (FR-8). Enter on a query not searched
   * yet searches it (the first occurrence) instead of moving.
   */
  protected searchKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.searching()) {
      event.preventDefault();
      this.typed.set('');
      this.applied.next('');
      return;
    }
    if (event.key === 'Enter' && this.typed() !== this.query()) {
      event.preventDefault();
      this.applied.next(this.typed());
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
    this.selected.set({ text, startMs: startOfRange(range, list) });
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

  private targetOf(key: string, from: number): number | null {
    const last = this.segments().length - 1;
    if (last < 0) return null;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    const step = STEPS[key];
    if (step === undefined) return null;
    return Math.min(last, Math.max(0, from + step));
  }

  /**
   * Scrolls only the list (never the page) so the segment sits in its upper third, unless
   * it is already comfortably in view; smooth unless reduced motion is asked.
   */
  private reveal(index: number, behavior: ScrollBehavior = 'smooth'): void {
    this.scrollList(this.scrollTargetOf(index), behavior);
  }

  /** Where the list must scroll for the segment to sit in its upper third; null when in view. */
  private scrollTargetOf(index: number): number | null {
    const list = this.list()?.nativeElement;
    const item = this.items()[index]?.nativeElement;
    if (!list || !item) return null;
    const margin = list.clientHeight * COMFORT;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    const inView =
      top >= list.scrollTop + margin &&
      bottom <= list.scrollTop + list.clientHeight - margin;
    return inView ? null : Math.max(0, top - list.clientHeight / 3);
  }

  /** Scrolls only the list (never the page), smooth unless reduced motion is asked. */
  private scrollList(
    target: number | null,
    behavior: ScrollBehavior = 'smooth',
  ): void {
    const list = this.list()?.nativeElement;
    if (!list || target === null) return;
    const reduced =
      this.document.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? false;
    if (typeof list.scrollTo === 'function')
      list.scrollTo({ top: target, behavior: reduced ? 'instant' : behavior });
    else list.scrollTop = target;
  }
}

const COPY_FAILED = () =>
  $localize`:@@transcript.copyFailed:Não consegui copiar. Copie o trecho à mão.`;

/**
 * Where the selected passage starts: the segment holding its start, or (a selection that
 * starts between segments) the first segment it covers.
 */
function startOfRange(range: Range, list: HTMLElement): number {
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  const holding = element?.closest<HTMLElement>('[data-start-ms]');
  const first = Array.from(
    list.querySelectorAll<HTMLElement>('[data-start-ms]'),
  ).find((item) => range.intersectsNode(item));
  return Number((holding ?? first)?.dataset['startMs'] ?? 0);
}

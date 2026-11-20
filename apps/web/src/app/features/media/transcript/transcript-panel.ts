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
  effect,
  linkedSignal,
  signal,
  untracked,
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
  wordAtOffset,
  type SearchHit,
  type SpokenWord,
} from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { MediaApi, mediaPagePath } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { PlaybackClock } from '@core/media/playback-clock.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import type { PassageFocus } from '../search-hit/passage-focus.js';
import {
  EMPTY,
  Subject,
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  merge,
  skip,
  switchMap,
} from 'rxjs';
import { speakerChanges, type SpeakerShown } from '../voices/speaker-names.js';
import { VoiceTag } from '../voices/voice-tag.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { UiBanner, UiIcon, UiIconButton } from '@ui/index.js';
import { SEARCH_HIGHLIGHTS } from './search-highlights.js';
import { CARET_AT_POINT } from './text-caret.js';
import { TranscriptWords, wordsPageOf } from './transcript-words.js';

/** One segment as the list shows it. */
interface SegmentView {
  readonly index: number;
  readonly startMs: number;
  readonly clock: string;
  readonly label: string;
  readonly text: string;
  /** Inside a track above the person's level (KBC-106): no text, only its name. */
  readonly restricted: boolean;
  /** A restricted segment right after another: the part is one line (review m2). */
  readonly folded: boolean;
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
 * A scroll of the list this soon after a wheel or a touch over it is the person's (FR-3). A
 * wheel's momentum keeps sending wheels, so the window only has to cover one frame or two.
 */
const GESTURE_MS = 300;

/** This close to the end of a page of words, the next one is asked for (KBC-045). */
const NEXT_PAGE_SEGMENTS = 5;

const NO_WORDS: readonly SpokenWord[] = [];

/**
 * The transcript beside the player (screens.md T15, KBC-038): the segment being heard is
 * marked (`aria-current`, background and side bar) and kept in view without stealing the
 * focus; any scrolling by the person stops that until "Voltar ao trecho atual", a segment
 * or a skip in the player. One Tab stop with ↑/↓, Home/End and Enter (FR-7), search
 * without accents (FR-8) and copying a selection with the minute's link (FR-9). Inside the
 * active segment the spoken word is painted, and a click plays from the word (KBC-045).
 */
@Component({
  selector: 'app-transcript-panel',
  imports: [DatePipe, UiBanner, UiIcon, UiIconButton, VoiceTag],
  templateUrl: './transcript-panel.html',
  styleUrl: './transcript-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The list's own events, taken here: a click anywhere on a segment plays it, and the
  // keys move between the time buttons (the buttons are what is focusable).
  host: {
    '(click)': 'clickSegment($event)',
    '(keydown)': 'moveWithKeys($event)',
    '(pointerdown)': 'pressList($event)',
    '[class.in-player]': 'inPlayer()',
    '[class.expanded]': 'expanded()',
  },
})
export class TranscriptPanel {
  readonly transcript = input.required<MediaTranscript>();
  /** The media's title, for "Copiar com o link do minuto". */
  readonly title = input.required<string>();
  /** The passage opened from a search hit, painted over its segments (KBC-039 AC-10). */
  readonly passage = input<PassageFocus | null>(null);
  /**
   * A passage cited by the research (KBC-099, T22): scrolled into the list's upper third as
   * soon as it shows, with no playback to follow, and marked with a side bar besides the paint.
   */
  readonly revealPassage = input(false);
  /** Its own "Transcrição" title; off where the host already titles it (KBC-150). */
  readonly showTitle = input(true);
  /** "Mostrar quem fala" (KBC-065 FR-4). */
  readonly showSpeakers = input(true);
  /** "Destacar palavra a palavra" (KBC-045 FR-4). */
  readonly wordByWord = input(true);
  /**
   * The player page's body (v2): on a phone the list is the full-screen player's card,
   * three lines around the one heard, with search and expand as round buttons.
   */
  readonly inPlayer = input(false);
  /** The phone card shows the whole list (expand). */
  protected readonly expanded = signal(false);
  protected readonly expandLabel = computed(() =>
    this.expanded()
      ? $localize`:@@transcript.collapse:Mostrar menos da transcrição`
      : $localize`:@@transcript.expand:Mostrar a transcrição inteira`,
  );
  /** The phone card's search field, opened by its round button. */
  protected readonly searchOpen = signal(false);

  private readonly engine = inject(MediaEngine);
  private readonly clock = inject(PlaybackClock);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly caretAt = inject(CARET_AT_POINT);
  private readonly mediaApi = inject(MediaApi);
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
  /** The words come apart from the transcript, a page at a time (KBC-045 FR-1). */
  private readonly words = new TranscriptWords(this.transcript, (id, range) =>
    this.mediaApi.transcriptWords(id, range),
  );
  /** The pages the highlight needs now, for this transcript; none when it is off (FR-4). */
  private readonly neededPages = computed(
    () => {
      if (!this.wordByWord()) return { key: '', pages: [] };
      const active = Math.max(0, this.activeIndex());
      const near = Math.min(
        active + NEXT_PAGE_SEGMENTS,
        this.segments().length - 1,
      );
      return {
        key: this.words.key(),
        pages: [
          ...new Set([wordsPageOf(active), wordsPageOf(Math.max(0, near))]),
        ],
      };
    },
    { equal: (a, b) => a.key === b.key && a.pages.join() === b.pages.join() },
  );
  private readonly activeWords = computed(() =>
    this.wordByWord()
      ? (this.words.of(this.activeIndex()) ?? NO_WORDS)
      : NO_WORDS,
  );
  /**
   * Read on every frame while playing: a binary search over one segment's words, and what
   * depends on it runs only when the word changes (FR-2, NFR-2).
   */
  private readonly activeWord = computed(() =>
    lastStartedAt(this.activeWords(), this.clock.positionMs()),
  );
  /** A click on a word whose page is not here yet; null cancels the one pending. */
  private readonly pendingWord = new Subject<{
    readonly segment: number;
    readonly char: number;
    /** The engine's seek count after the click's own: any later seek outranks the word. */
    readonly seeks: number;
  } | null>();
  /** Off once the person scrolls or moves through the list themselves (FR-3). */
  private readonly tracking = signal(true);
  /** When a wheel or a touch last moved over the list: it may be about to scroll it. */
  private gestureAt = Number.NEGATIVE_INFINITY;
  /** The list's own scroll in flight (following, a search hit): its scroll events. */
  private selfScroll: {
    readonly from: number;
    readonly to: number;
    readonly until: number;
  } | null = null;
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
    () => this.moved() ?? Math.max(0, this.currentIndex()),
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
  /** Words typed that no segment has. */
  protected readonly noHits = computed(
    () => this.query().trim() !== '' && this.hits().length === 0,
  );
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
      // KBC-106: a part above the person's level comes with no text; it is named instead.
      text: segment.restricted
        ? $localize`:@@transcript.restricted:Trecho restrito`
        : segment.text,
      restricted: segment.restricted === true,
      folded:
        segment.restricted === true && segments[index - 1]?.restricted === true,
      speaker: changes.get(index) ?? null,
    }));
  });
  /** Who speaks, once each in order of first speech (the chips over the list, tLine). */
  protected readonly legend = computed(() => {
    const seen = new Map<number, string | null>();
    for (const segment of this.view())
      if (segment.speaker && !seen.has(segment.speaker.voice))
        seen.set(segment.speaker.voice, segment.speaker.name ?? null);
    return seen.size > 1 || [...seen.values()].some((name) => name !== null)
      ? [...seen].map(([voice, name]) => ({ voice, name }))
      : [];
  });
  private readonly bookmarks = inject(BookmarksStore);
  /** The segments holding one of the person's bookmarks: a green mark before the time. */
  protected readonly marked = computed(() => {
    const segments = this.segments();
    const marked = new Set<number>();
    if (this.bookmarks.mediaId() !== this.transcript().mediaId) return marked;
    for (const at of this.bookmarks.positions()) {
      const index = lastStartedAt(segments, at);
      if (index >= 0) marked.add(index);
    }
    return marked;
  });

  /** The phone card's search button: opens the field and gives it the focus. */
  protected toggleSearch(): void {
    const open = !this.searchOpen();
    this.searchOpen.set(open);
    if (open)
      afterNextRender(
        () => this.document.getElementById('transcript-search')?.focus(),
        { injector: this.injector },
      );
  }

  /** The segment of the current occurrence: its outline shows it in any browser. */
  protected readonly currentHitSegment = computed(
    () => this.hits()[this.currentHit()]?.segment ?? -1,
  );
  protected readonly selected = signal<Selected | null>(null);
  /** The segments of a cited passage (KBC-099): marked and brought into view. */
  protected readonly citedIndexes = computed((): readonly number[] => {
    const passage = this.passage();
    if (!this.revealPassage() || passage?.mediaId !== this.transcript().mediaId)
      return [];
    return this.passageIndexes(passage);
  });
  protected readonly cited = computed(() => new Set(this.citedIndexes()));
  /** The engine plays this transcript's media now. */
  private readonly playingThis = computed(
    () =>
      this.engine.playing() &&
      this.engine.source()?.id === this.transcript().mediaId,
  );
  /** This transcript's media played since the list showed (or a segment was asked for). */
  private readonly heard = signal(false);
  /**
   * T22: until something plays, the cited passage is the current one (`aria-current`, the
   * side bar) and the segment the paused player sits in at −2 s is not marked as heard, so
   * the eye and a screen reader land on what the answer cites, not on the speech before it.
   */
  protected readonly holdingCited = computed(
    () => !this.heard() && this.citedIndexes().length > 0,
  );
  /**
   * The segment marked (and followed) as the one heard: none while the cited passage holds,
   * so the list stays on it, not on the segment at −2 s.
   */
  protected readonly shownActive = computed(() =>
    this.holdingCited() || this.untouched() ? -1 : this.activeIndex(),
  );
  /** Who carries `aria-current`: the first cited segment, until something plays. */
  protected readonly currentIndex = computed(() =>
    this.holdingCited()
      ? (this.citedIndexes()[0] ?? -1)
      : this.untouched()
        ? -1
        : this.activeIndex(),
  );
  /**
   * Opened at the start (its first second) and not played yet: nothing is "now" (v2 ·
   * Mídia — Player, the listener's frame paused at 0:00 marks no line); a play, or a seek
   * or a resume further in, marks one.
   */
  private readonly untouched = computed(
    () => !this.heard() && this.clock.positionMs() < 1000,
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.clock.follow(() => true, destroyRef);
    this.listenPassively(destroyRef);
    this.followAgain();
    // Measure, then scroll: one layout per change, never a read after a write.
    afterRenderEffect({
      earlyRead: () => {
        const index = this.shownActive();
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
    this.revealCited();
    this.paintSearch(destroyRef);
    this.paintPassage(destroyRef);
    this.paintWord(destroyRef);
    this.loadNeededWords(destroyRef);
    this.landOnPendingWord();
  }

  /**
   * A skip or a jump in the player brings the list back to what is heard (FR-3); so does a
   * new play of this media, from here or from the app's bar (KBC-154).
   */
  private followAgain(): void {
    toObservable(this.engine.seeksLanded)
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe(() => this.resumeTracking());
    toObservable(this.playingThis)
      .pipe(skip(1), filter(Boolean), takeUntilDestroyed())
      .subscribe(() => this.resumeTracking());
  }

  /** Once this media plays, the cited passage no longer holds `aria-current` (T22). */
  private noteHeard(): void {
    effect(() => {
      if (this.playingThis()) this.heard.set(true);
    });
  }

  /**
   * A cited passage comes into the list's upper third as soon as it shows (KBC-099), and
   * holds `aria-current` until the media plays (T22).
   */
  private revealCited(): void {
    afterRenderEffect({
      earlyRead: () => {
        const [first] = this.citedIndexes();
        return first === undefined ? null : this.scrollTargetOf(first);
      },
      write: (target) => this.scrollList(target()),
    });
    this.noteHeard();
  }

  /**
   * The active segment's page, and the next one a little before it is reached. An effect,
   * since a request is no signal: it also runs for a new version of the transcript.
   */
  private loadNeededWords(destroyRef: DestroyRef): void {
    effect(() => {
      const { pages } = this.neededPages();
      untracked(() => {
        for (const page of pages)
          this.words
            .load(page)
            .pipe(takeUntilDestroyed(destroyRef))
            .subscribe();
      });
    });
  }

  /**
   * Once the page of a clicked word arrives, moves from its segment to the word (FR-3),
   * unless the person went elsewhere meanwhile: a skip, the slider, a bookmark, the keys.
   */
  private landOnPendingWord(): void {
    this.pendingWord
      .pipe(
        switchMap((clicked) =>
          clicked
            ? this.words.load(wordsPageOf(clicked.segment)).pipe(
                map(() => this.wordAt(clicked.segment, clicked.char)),
                filter((word) => word !== null),
                filter(() => this.engine.seeksAsked() === clicked.seeks),
              )
            : EMPTY,
        ),
        takeUntilDestroyed(),
      )
      .subscribe((word) => this.engine.seek(word.startMs));
  }

  private wordAt(segment: number, char: number): SpokenWord | null {
    return wordAtOffset(this.words.of(segment) ?? NO_WORDS, char);
  }

  /**
   * The spoken word, painted like the search: one range replaced when the word changes (at
   * most one write per word, FR-2), and no element around it, so nothing lays out (NFR-2).
   */
  private paintWord(destroyRef: DestroyRef): void {
    const highlights = inject(SEARCH_HIGHLIGHTS);
    afterRenderEffect({
      write: () => {
        // No word lit where no line is marked (a cited passage holds, or nothing played).
        const word =
          this.shownActive() < 0
            ? undefined
            : this.activeWords()[this.activeWord()];
        const range =
          word &&
          this.rangeOf({
            segment: this.activeIndex(),
            start: word.charStart,
            end: word.charEnd,
          });
        highlights.show('transcript-word', range ? [range] : []);
      },
    });
    destroyRef.onDestroy(() => highlights.clear('transcript-word'));
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
   * Wheel, touch and the list's scroll only read where the person scrolls: passive, so
   * scrolling never waits for the page (no host binding offers that). The list's scroll is
   * caught on its way down (it does not bubble), since the list comes and goes with the
   * transcript. The selection is read from the document.
   */
  private listenPassively(destroyRef: DestroyRef): void {
    const renderer = inject(Renderer2);
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const passive = { passive: true };
    const stops = [
      renderer.listen(host, 'wheel', (e: Event) => this.aimedAt(e), passive),
      renderer.listen(
        host,
        'touchmove',
        (e: Event) => this.aimedAt(e),
        passive,
      ),
      renderer.listen(host, 'scroll', (e: Event) => this.listScrolled(e), {
        capture: true,
        passive: true,
      }),
      renderer.listen('document', 'selectionchange', () =>
        this.readSelection(),
      ),
    ];
    destroyRef.onDestroy(() => stops.forEach((stop) => stop()));
  }

  /**
   * Clicking a segment's time plays from it (FR-4), and its text from the word under the
   * pointer (KBC-045 FR-3); a selection is left alone.
   */
  protected clickSegment(event: MouseEvent): void {
    const index = this.segmentOf(event.target);
    // `detail` is 0 for Enter and Space on the time button: always a request to play.
    if (index === null || (event.detail > 0 && this.selected() !== null))
      return;
    this.playFrom(index, this.charUnder(event, index));
  }

  /** The character clicked in the segment's text; null off the text, or from the keyboard. */
  private charUnder(event: MouseEvent, index: number): number | null {
    const onText =
      event.detail > 0 &&
      event.target instanceof Element &&
      event.target.closest('.text') !== null;
    if (!onText) return null;
    const caret = this.caretAt(event.clientX, event.clientY);
    return caret?.node === this.textNodeOf(index)
      ? (caret?.offset ?? null)
      : null;
  }

  /** ↑/↓, PageUp/PageDown, Home/End move the one Tab stop (FR-7); the list stops following. */
  protected moveWithKeys(event: KeyboardEvent): void {
    const from = this.segmentOf(event.target);
    if (from === null) {
      // The list itself has the focus: its keys scroll it, the person reads elsewhere (FR-3).
      if (this.isList(event.target) && LIST_SCROLL_KEYS.has(event.key))
        this.stopFollowing();
      return;
    }
    // From the segment with the focus, not the one playing (it may have moved on).
    const target = this.targetOf(event.key, from);
    if (target === null) return;
    event.preventDefault();
    this.tracking.set(false);
    this.moved.set(target);
    this.times()[target]?.nativeElement.focus();
  }

  /**
   * A wheel or a touch over the list. Not yet a scroll of it: the page may be the one that
   * moves (a wheel that started over the page keeps scrolling it as the list slides under
   * the pointer, KBC-162); only the list's own scroll that follows stops the following.
   */
  private aimedAt(event: Event): void {
    if (this.segmentOf(event.target) !== null || this.isList(event.target))
      this.gestureAt = this.now();
  }

  /** The list scrolled: by the person's wheel or touch, the person reads elsewhere (FR-3). */
  private listScrolled(event: Event): void {
    const list = this.list()?.nativeElement;
    if (!list || event.target !== list) return;
    if (this.ownScroll(list.scrollTop)) return;
    if (this.now() - this.gestureAt <= GESTURE_MS) this.stopFollowing();
  }

  /**
   * Whether the list's scroll is still the one this panel asked for: between where it was
   * and where it goes. Anything else (the person took over) ends it.
   */
  private ownScroll(top: number): boolean {
    const own = this.selfScroll;
    if (!own) return false;
    // A smooth scroll that stopped short never lands: past its time it is no longer ours.
    if (this.now() > own.until) {
      this.selfScroll = null;
      return false;
    }
    const low = Math.min(own.from, own.to) - 1;
    const high = Math.max(own.from, own.to) + 1;
    if (top < low || top > high) {
      this.selfScroll = null;
      return false;
    }
    if (Math.abs(top - own.to) < 1) this.selfScroll = null;
    return true;
  }

  private now(): number {
    return this.document.defaultView?.performance.now() ?? Date.now();
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

  /**
   * Plays a segment, or the word at `char` in it. Both happen inside the person's gesture:
   * Safari refuses a `play()` that comes after a request, so a word whose page is not here
   * starts at its segment and moves to the word when the page arrives.
   */
  private playFrom(index: number, char: number | null = null): void {
    const segment = this.segments()[index];
    if (!segment) return;
    this.resumeTracking();
    this.heard.set(true);
    this.moved.set(index);
    const word = char === null ? null : this.wordAt(index, char);
    this.engine.seek(word?.startMs ?? segment.startMs);
    this.engine.play();
    const waiting = char !== null && this.words.of(index) === null;
    this.pendingWord.next(
      waiting
        ? { segment: index, char, seeks: this.engine.seeksAsked() }
        : null,
    );
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
    let target = Math.min(last, Math.max(0, from + step));
    // A restricted part is one line: the keys pass over the segments folded into it.
    const segments = this.segments();
    while (
      target > 0 &&
      target < last &&
      segments[target]?.restricted &&
      segments[target - 1]?.restricted
    )
      target += step;
    return target;
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
    // The phone card (pMobile): the line before on top, then the one heard, then the next.
    if (this.inPlayer() && !this.expanded() && list.clientHeight < CARD_MAX) {
      const before = this.items()
        .slice(0, index)
        .reverse()
        .find((one) => !one.nativeElement.hidden)?.nativeElement;
      const target = before ? before.offsetTop : item.offsetTop;
      return Math.abs(list.scrollTop - target) < 1 ? null : target;
    }
    const band = this.shownBand(list, item.offsetHeight);
    const margin = band.height * COMFORT;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    const inView =
      top >= band.start + margin && bottom <= band.start + band.height - margin;
    return inView
      ? null
      : Math.max(0, top - (band.start - list.scrollTop) - band.height / 3);
  }

  /**
   * The part of the list on the screen, in its scroll coordinates. The page's own scroller
   * (the main panel) can cut the list off below the fold, and a line in the list's upper
   * third would then be off the screen (KBC-162). The whole list when it all shows, or when
   * not even a line of it does (nothing better without scrolling the page).
   */
  private shownBand(
    list: HTMLElement,
    lineHeight: number,
  ): { readonly start: number; readonly height: number } {
    const whole = { start: list.scrollTop, height: list.clientHeight };
    const view = this.document.defaultView;
    if (!view) return whole;
    const inner = list.getBoundingClientRect().top + list.clientTop;
    let top = Math.max(inner, 0);
    let bottom = Math.min(inner + list.clientHeight, view.innerHeight);
    for (let at = list.parentElement; at; at = at.parentElement) {
      if (view.getComputedStyle(at).overflowY === 'visible') continue;
      const clip = at.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    const height = bottom - top;
    return height >= list.clientHeight - 1 || height < lineHeight
      ? whole
      : { start: list.scrollTop + top - inner, height };
  }

  /** Scrolls only the list (never the page), smooth unless reduced motion is asked. */
  private scrollList(
    target: number | null,
    behavior: ScrollBehavior = 'smooth',
  ): void {
    const list = this.list()?.nativeElement;
    if (!list || target === null) return;
    // Where the list can really go (the browser stops there), so its scroll is known as
    // this panel's until it lands, and the person's after.
    const to = Math.max(
      0,
      Math.min(target, list.scrollHeight - list.clientHeight),
    );
    this.selfScroll =
      Math.abs(list.scrollTop - to) < 1
        ? null
        : { from: list.scrollTop, to, until: this.now() + SELF_SCROLL_MS };
    const reduced =
      this.document.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? false;
    if (typeof list.scrollTo === 'function')
      list.scrollTo({ top: target, behavior: reduced ? 'instant' : behavior });
    else list.scrollTop = target;
  }
}

/** The keys that scroll the list when it has the focus itself. */
const LIST_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/** The longest a smooth scroll of the list takes; past it, a scroll is the person's. */
const SELF_SCROLL_MS = 1_500;

/** Under this height the list is the phone card of three lines, not a column. */
const CARD_MAX = 200;

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

import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Renderer2,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { TranscriptCorrection } from '@kb-chat/contracts';
import { wordAtOffset, type TimedSpan } from '@kb-chat/player-core';
import { SessionStore } from '@core/auth/session-store.js';
import { CorrectAll } from '../corrections/correct-all.js';
import { CorrectionDesk } from '../corrections/correction-desk.js';
import { CorrectionHistory } from '../corrections/correction-history.js';
import { WordCorrection } from '../corrections/word-correction.js';
import { WordSearch, type WordHit } from '../corrections/word-search.js';
import { SEARCH_HIGHLIGHTS } from '../transcript/search-highlights.js';
import { CARET_AT_POINT } from '../transcript/text-caret.js';
import { wordsPageOf } from '../transcript/transcript-words.js';
import { TrackAudition } from './track-audition.js';
import {
  neededSegments,
  sameSpoken,
  spokenAt,
  trackLines,
  wholeLines,
  type Spoken,
  type TextLine,
} from './track-text-lines.js';
import { TrackTextSource } from './track-text-source.js';

/** Where a choice falls in a line's text. */
interface Offsets {
  readonly start: number;
  readonly end: number;
}

/** A word's place in the transcript, which the words of a line carry (KBC-093). */
const positionOf = (word: object | null): number | null =>
  word !== null && 'position' in word && typeof word.position === 'number'
    ? word.position
    : null;

/** After the person scrolls the block, it does not follow the word for this long (FR-4). */
export const OWN_SCROLL_MS = 5_000;

/** The word is kept within this share of the block from its top and bottom. */
const COMFORT = 0.15;

/** Keys that scroll the focused block: the person reads elsewhere. */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/**
 * "Texto da faixa" (T20, KBC-092): what the track says, cut at its bounds (BR-1), with the
 * word being said painted while the screen's own listening plays it (BR-2, BR-6), by
 * KBC-045's method: one text node per line and a CSS Custom Highlight, never an element
 * per word, so a word change costs one range and no layout (NFR-2). The block scrolls by
 * itself only inside (FR-4), and can show the whole transcript with the track marked
 * (AC-18). A word stays findable by its place in the text (KBC-093).
 */
@Component({
  selector: 'app-track-text',
  imports: [WordCorrection, WordSearch, CorrectAll, CorrectionHistory],
  providers: [CorrectionDesk],
  templateUrl: './track-text.html',
  styleUrl: './track-text.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackText {
  private readonly source = inject(TrackTextSource);
  private readonly audition = inject(TrackAudition);
  private readonly highlights = inject(SEARCH_HIGHLIGHTS);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly renderer = inject(Renderer2);
  private readonly caretAt = inject(CARET_AT_POINT);
  protected readonly desk = inject(CorrectionDesk);
  /** Words react to a click only for whoever may correct them (BR-5, AC-16, AC-46). */
  protected readonly canCorrect = inject(SessionStore).can('media-correct');

  readonly span = input.required<TimedSpan>();
  readonly ordinal = input.required<number>();
  /** The block's id, for the control that opens it (`aria-controls`). */
  readonly regionId = input<string | null>(null);

  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');
  private readonly lineElements = viewChildren<ElementRef<HTMLElement>>('line');
  private readonly search = viewChild(WordSearch);

  protected readonly state = this.source.state;
  /** "Tentar de novo" is reading: the error stays until it answers. */
  protected readonly retrying = this.source.retrying;
  /** Said by the screen reader as it happens: a failure, and the retry going on. */
  protected readonly announcement = computed(() => {
    if (this.state() !== 'error') return '';
    return this.retrying()
      ? $localize`:@@trackText.retrying:Carregando o texto…`
      : $localize`:@@trackText.errorSaid:Não consegui carregar o texto.`;
  });
  /** "Ver transcrição completa" (AC-18). */
  protected readonly whole = signal(false);
  private readonly segments = computed(
    () => this.source.transcript()?.segments ?? [],
  );
  protected readonly lines = computed(() => {
    const wordsOf = (segment: number) => this.source.words.of(segment);
    return this.whole()
      ? wholeLines(this.segments(), wordsOf, this.span())
      : trackLines(this.segments(), wordsOf, this.span());
  });
  protected readonly label = computed(
    () =>
      $localize`:@@trackText.region:Texto da faixa ${this.ordinal()}:ordinal:`,
  );
  /** The whole transcript's first and last lines of the track, for the screen reader. */
  protected readonly trackBounds = computed(() => {
    if (!this.whole()) return { first: -1, last: -1 };
    const lines = this.lines();
    return {
      first: lines.findIndex((line) => line.inside),
      last: lines.findLastIndex((line) => line.inside),
    };
  });
  protected readonly canSwitch = computed(
    () => this.state() === 'ready' && this.segments().length > 0,
  );
  /**
   * Read on every frame while playing: binary searches, and what depends on it runs only
   * when the word changes (NFR-2).
   */
  private readonly spoken = computed<Spoken | null>(
    () => spokenAt(this.lines(), this.span(), this.audition.positionMs()),
    { equal: sameSpoken },
  );
  /** Where the browser cannot paint a range, the line playing is marked instead. */
  private readonly paints = this.highlights.paints !== false;
  /** The line marked whole: no word times (BR-4), or no highlights in this browser. */
  protected readonly speakingLine = computed(() => {
    const spoken = this.spoken();
    return spoken && (spoken.whole || !this.paints) ? spoken.line : -1;
  });
  /** The pages of words this track needs now (FR-3). */
  private readonly neededPages = computed(
    () => {
      const at = this.audition.positionMs();
      return {
        key: this.source.words.key(),
        pages: [
          ...new Set(
            neededSegments(this.segments(), this.span(), at).map(wordsPageOf),
          ),
        ],
      };
    },
    { equal: (a, b) => a.key === b.key && a.pages.join() === b.pages.join() },
  );
  /** "Procurar palavra" open (FR-4) and the history (FR-9). */
  protected readonly searching = signal(false);
  protected readonly historyOpen = signal(false);
  protected readonly corrections = computed(
    () => this.desk.history()?.total ?? 0,
  );
  /** "1 correção reaplicada; 1 não coube na transcrição nova" (FR-8, AC-19). */
  protected readonly carry = computed(() => this.desk.history()?.carry ?? null);
  /** Where the chosen word came from: the focus goes back there (FR-3, AC-22). */
  private chosenFrom: 'text' | 'search' = 'text';
  /** When the person last scrolled the block themselves. */
  private ownScrollAt = Number.NEGATIVE_INFINITY;
  /** The retry button disappears with the error: the focus goes on to the text. */
  private focusWhenReady = false;

  constructor() {
    this.source.open();
    this.loadNeededWords();
    this.paintWord();
    this.paintLearned();
    this.followWord();
    this.showTrackInWhole();
    this.focusAfterRetry();
    afterNextRender(() => this.listenPassively());
    if (this.canCorrect) this.followCorrections();
  }

  /** The history once the text is there, the chosen words painted, the focus kept. */
  private followCorrections(): void {
    effect(() => {
      this.desk.playUntil(this.span().endMs);
      if (this.state() === 'ready')
        untracked(() => {
          if (this.desk.history() === null) this.desk.loadHistory();
        });
    });
    afterRenderEffect({
      write: () => {
        const range = this.chosenRange();
        this.highlights.show('correcting-word', range ? [range] : []);
      },
    });
    this.destroyRef.onDestroy(() => this.highlights.clear('correcting-word'));
    this.refocusWhenClosed();
  }

  /**
   * The words the learning replaced get a subtle mark (KBC-113 FR-6), for everyone who
   * reads the text: one highlight, no element per word (KBC-093 NFR-5).
   */
  private paintLearned(): void {
    afterRenderEffect({
      write: () => {
        const learned = this.source.words.learned();
        const ranges: Range[] = [];
        if (learned.size > 0)
          this.lines().forEach((line, index) => {
            for (const word of line.words ?? []) {
              const position = positionOf(word);
              if (position === null || !learned.has(position)) continue;
              const range = this.rangeOf({
                line: index,
                start: word.charStart,
                end: word.charEnd,
                whole: false,
              });
              if (range) ranges.push(range);
            }
          });
        this.highlights.show('learned-word', ranges);
      },
    });
    this.destroyRef.onDestroy(() => this.highlights.clear('learned-word'));
  }

  /** A word clicked (BR-17): the audio goes to it and the panel opens on it, once. */
  protected clickedText(event: MouseEvent): void {
    if (!this.canCorrect || this.state() !== 'ready') return;
    const caret = this.caretAt(event.clientX, event.clientY);
    if (!caret) return;
    const index = this.lineElements().findIndex(({ nativeElement }) =>
      nativeElement.contains(caret.node),
    );
    const line = this.lines()[index];
    if (!line) return;
    this.chosenFrom = 'text';
    const selected = this.selectedOffsets(index);
    this.pick(line, selected ?? { start: caret.offset, end: caret.offset });
  }

  /** "Procurar palavra": an occurrence chosen with Enter or a click (FR-4, FR-14). */
  protected chosenHit(hit: WordHit): void {
    const line = this.lines()[hit.line];
    if (!line) return;
    this.chosenFrom = 'search';
    this.pick(line, { start: hit.offset, end: hit.offset });
  }

  /** The line's words, brought in when their page is not here yet. */
  private pick(
    line: TextLine,
    at: Offsets | ((line: TextLine) => Offsets | null),
  ): void {
    const where = typeof at === 'function' ? at : () => at;
    if (line.words !== null) {
      this.pickIn(line, where(line));
      return;
    }
    this.source.words
      .load(wordsPageOf(line.segment))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => {
          const now = this.lines().find((one) => one.segment === line.segment);
          if (now?.words) this.pickIn(now, where(now));
        },
      });
  }

  private pickIn(line: TextLine, at: Offsets | null): void {
    if (!at) return;
    const words = line.words ?? [];
    const first = positionOf(wordAtOffset(words, at.start));
    const last = positionOf(
      wordAtOffset(words, Math.max(at.start, at.end - 1)),
    );
    if (first === null) return;
    this.desk.choose(line.segment, first, last ?? first);
  }

  /** A stretch selected in one line when clicking: the choice starts from it (FR-2). */
  private selectedOffsets(
    index: number,
  ): { start: number; end: number } | null {
    const selection = this.document.getSelection();
    const node = this.lineOf(index)?.firstChild;
    if (!selection || selection.isCollapsed || !node) return null;
    const range = selection.getRangeAt(0);
    if (range.startContainer !== node || range.endContainer !== node)
      return null;
    return { start: range.startOffset, end: range.endOffset };
  }

  /** The chosen words in their line's text, to paint them (NFR-5). */
  private chosenRange(): Range | null {
    const words = this.desk.words();
    const selection = this.desk.selection();
    const lines = this.lines();
    if (!selection || words.length === 0) return null;
    const index = lines.findIndex((line) => line.segment === selection.segment);
    const placed = (lines[index]?.words ?? []).filter((word) => {
      const position = positionOf(word);
      return (
        position !== null && words.some((one) => one.position === position)
      );
    });
    const first = placed[0];
    const last = placed.at(-1);
    if (!first || !last) return null;
    return this.rangeOf({
      line: index,
      start: first.charStart,
      end: last.charEnd,
      whole: false,
    });
  }

  /** The panel closed with the focus inside it: back where the word was chosen (PD-01). */
  private refocusWhenClosed(): void {
    let open = false;
    afterRenderEffect(() => {
      const now = this.desk.selection() !== null;
      if (open && !now) {
        const active = this.document.activeElement;
        if (active === null || active === this.document.body) this.refocus();
      }
      open = now;
    });
  }

  protected refocus(): void {
    if (this.chosenFrom === 'search' && this.search()) this.search()?.refocus();
    else this.body().nativeElement.focus();
  }

  protected toggleSearch(): void {
    this.searching.update((open) => !open);
  }

  protected openHistory(): void {
    this.desk.loadHistory();
    this.historyOpen.set(true);
  }

  /** "Corrigir aqui": the word now said where the correction was (FR-8). */
  protected fixHere(row: TranscriptCorrection): void {
    const lines = this.lines();
    const line =
      lines.find((one) => one.endMs > row.startMs) ?? lines.at(-1) ?? null;
    if (!line) return;
    this.chosenFrom = 'text';
    this.pick(line, (now) => {
      const word = now.words?.find((one) => one.endMs > row.startMs);
      return word ? { start: word.charStart, end: word.charEnd } : null;
    });
  }

  protected switchView(): void {
    // A scroll in the other view says nothing about this one: it may follow the word.
    this.ownScrollAt = Number.NEGATIVE_INFINITY;
    this.whole.update((whole) => !whole);
  }

  protected retry(): void {
    if (this.retrying()) return;
    this.focusWhenReady = true;
    this.source.reload();
  }

  /** Keys that scroll the focused block, or a press on its scroll bar (FR-4). */
  protected scrolledByKey(event: KeyboardEvent): void {
    if (SCROLL_KEYS.has(event.key)) this.ownScroll();
  }

  protected pressed(event: PointerEvent): void {
    if (event.target === this.body().nativeElement) this.ownScroll();
  }

  private ownScroll(): void {
    this.ownScrollAt = performance.now();
  }

  /** A request is no signal: an effect asks for the pages, as the transcript does. */
  private loadNeededWords(): void {
    effect(() => {
      const { pages } = this.neededPages();
      untracked(() => {
        for (const page of pages)
          this.source.words
            .load(page)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe();
      });
    });
  }

  /** One range replaced when the word changes; nothing else is written (NFR-2). */
  private paintWord(): void {
    afterRenderEffect({
      write: () => {
        const spoken = this.spoken();
        this.lines();
        const range = spoken && !spoken.whole ? this.rangeOf(spoken) : null;
        this.highlights.show('track-word', range ? [range] : []);
      },
    });
    this.destroyRef.onDestroy(() => this.highlights.clear('track-word'));
  }

  /** Measure, then scroll the block only, never the page: one read per word (FR-4). */
  private followWord(): void {
    afterRenderEffect({
      earlyRead: () => {
        const spoken = this.spoken();
        const recent = performance.now() - this.ownScrollAt < OWN_SCROLL_MS;
        return spoken && !recent ? this.scrollTargetOf(spoken) : null;
      },
      write: (target) => this.scrollBody(target(), 'smooth'),
    });
  }

  /**
   * Opening the whole transcript lands on the track's first line (AC-18), measured in the
   * block, which is no offset parent. A word playing is left to `followWord`.
   */
  private showTrackInWhole(): void {
    afterRenderEffect({
      earlyRead: () => {
        if (!this.whole()) return null;
        return untracked(() => {
          if (this.spoken()) return null;
          const first = this.lines().findIndex((line) => line.inside);
          const element = this.lineOf(first);
          if (!element) return null;
          const body = this.body().nativeElement;
          // Below the block's border and padding, as its first line sits at the top.
          const inset =
            body.clientTop +
            Number.parseFloat(getComputedStyle(body).paddingTop || '0');
          return (
            body.scrollTop +
            element.getBoundingClientRect().top -
            body.getBoundingClientRect().top -
            inset
          );
        });
      },
      write: (target) => this.scrollBody(target(), 'instant'),
    });
  }

  /** After "Tentar de novo" worked, the focus that was on it goes to the text (PD-01). */
  private focusAfterRetry(): void {
    afterRenderEffect(() => {
      const state = this.state();
      // Failed again: the focus stays on the button, and nothing moves it later.
      if (state === 'error' && !this.retrying()) this.focusWhenReady = false;
      if (state !== 'ready' || !this.focusWhenReady) return;
      this.focusWhenReady = false;
      const active = this.document.activeElement;
      if (active === null || active === this.document.body)
        this.body().nativeElement.focus();
    });
  }

  private scrollTargetOf(spoken: Spoken): number | null {
    const body = this.body().nativeElement;
    const target = spoken.whole
      ? this.lineOf(spoken.line)
      : this.rangeOf(spoken);
    // jsdom has no layout for a range.
    if (typeof target?.getBoundingClientRect !== 'function') return null;
    const box = target.getBoundingClientRect();
    const view = body.getBoundingClientRect();
    const margin = view.height * COMFORT;
    const inView =
      box.top >= view.top + margin && box.bottom <= view.bottom - margin;
    if (inView) return null;
    return Math.max(0, body.scrollTop + box.top - view.top - view.height / 3);
  }

  private scrollBody(target: number | null, behavior: ScrollBehavior): void {
    const body = this.body().nativeElement;
    if (target === null) return;
    const reduced =
      this.document.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? false;
    if (typeof body.scrollTo === 'function')
      body.scrollTo({ top: target, behavior: reduced ? 'instant' : behavior });
    else body.scrollTop = target;
  }

  private lineOf(index: number): HTMLElement | null {
    return this.lineElements()[index]?.nativeElement ?? null;
  }

  /** The word's characters in its line's one text node. */
  private rangeOf(spoken: Spoken): Range | null {
    const node = this.lineOf(spoken.line)?.firstChild;
    if (!(node instanceof Text)) return null;
    const range = this.document.createRange();
    range.setStart(node, Math.min(spoken.start, node.length));
    range.setEnd(node, Math.min(spoken.end, node.length));
    return range;
  }

  /** Wheel and touch only read that the person scrolls: passive, never waited for. */
  private listenPassively(): void {
    const body = this.body().nativeElement;
    const passive = { passive: true };
    const stops = ['wheel', 'touchmove'].map((name) =>
      this.renderer.listen(body, name, () => this.ownScroll(), passive),
    );
    this.destroyRef.onDestroy(() => stops.forEach((stop) => stop()));
  }
}

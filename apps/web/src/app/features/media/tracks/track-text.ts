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
import { CorrectionDesk, insideSaid } from '../corrections/correction-desk.js';
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
import {
  gestureOffsets,
  gestureStep,
  gestureTo,
  placedWords,
  wordAt,
  type Gesture,
  type TextPoint,
} from './word-gesture.js';

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

/** A finger held this long on a word starts choosing words (KBC-115 FR-2). */
export const LONG_PRESS_MS = 400;
/** A mouse moved this far with its button down is a drag, not a click (FR-1). */
const MOUSE_SLOP_PX = 4;
/** A finger moved this far before the long press is a scroll (FR-2). */
const TOUCH_SLOP_PX = 10;

/** A pointer held down on a word: it may become a drag (KBC-115 FR-1, FR-2). */
interface Press {
  readonly pointerId: number;
  readonly touch: boolean;
  readonly x: number;
  readonly y: number;
  readonly from: TextPoint;
  selecting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

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
  /** Words being chosen by dragging or by Shift+arrows, before the panel (KBC-115). */
  private readonly gesture = signal<Gesture | null>(null);
  /** A pointer held on a word; the click after a drag is not a click. */
  private press: Press | null = null;
  private swallowClick = false;
  /** The last click opened or changed the panel: its double click takes that back. */
  private openedByClick = false;
  /** The gesture comes from Shift+arrows: it opens when Shift is released (FR-4). */
  private byKeys = false;
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
    if (this.canCorrect) {
      this.followCorrections();
      this.holdScrollWhileChoosing();
    }
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
        const range = this.gestureRange() ?? this.chosenRange();
        this.highlights.show('correcting-word', range ? [range] : []);
      },
    });
    this.destroyRef.onDestroy(() => this.highlights.clear('correcting-word'));
    this.refocusWhenClosed();
  }

  /** The learning's words in the lines shown (FR-6), said in words beside the mark. */
  protected readonly learnedWords = computed(() => {
    const learned = this.source.words.learned();
    if (learned.size === 0) return 0;
    return this.lines()
      .flatMap((line) => line.words ?? [])
      .filter((word) => {
        const position = positionOf(word);
        return position !== null && learned.has(position);
      }).length;
  });

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
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    // The second and third clicks of a double or triple click select for copying: they
    // choose nothing, and the browser's selection stays as it made it.
    if (event.detail >= 2) return;
    const point = this.pointAt(event.clientX, event.clientY);
    const line = point ? this.lines()[point.line] : undefined;
    if (!point || !line) return;
    this.chosenFrom = 'text';
    if (event.shiftKey) {
      if (this.stretchTo(point)) return;
      // With nothing open, Shift+click is a click: not the browser's stretched selection.
      this.document.getSelection()?.removeAllRanges();
    }
    const selected = this.selectedOffsets(point.line);
    const before = this.desk.selection();
    this.pick(line, selected ?? { start: point.offset, end: point.offset });
    this.openedByClick = this.desk.selection() !== before;
  }

  /** The line and character under a point of the screen, if it is in a line. */
  private pointAt(x: number, y: number): TextPoint | null {
    const caret = this.caretAt(x, y);
    if (!caret) return null;
    const line = this.lineElements().findIndex(({ nativeElement }) =>
      nativeElement.contains(caret.node),
    );
    return line < 0 ? null : { line, offset: caret.offset };
  }

  /**
   * A point on a word for a drag (QA-3): in the space between two words, the nearer one by
   * where they are drawn, so every browser picks the same words whichever side of the space
   * its caret falls on. Where nothing is drawn (no layout), the caret's word.
   */
  private wordPointAt(x: number, y: number): TextPoint | null {
    const point = this.pointAt(x, y);
    if (!point) return null;
    const words = placedWords(this.lines()[point.line]);
    // Strictly inside a word: that word. At its first character the caret may stand for the
    // space before it (WebKit), so the drawing decides.
    const inside = words.some(
      (word) => word.charStart < point.offset && point.offset < word.charEnd,
    );
    const before = words.findLast((word) => word.charEnd <= point.offset);
    const after = words.find((word) => word.charStart >= point.offset);
    if (inside || !before || !after) return point;
    const box = (word: { charStart: number; charEnd: number }) => {
      const range = this.rangeOf({
        line: point.line,
        start: word.charStart,
        end: word.charEnd,
        whole: false,
      });
      return typeof range?.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : null;
    };
    const left = box(before);
    const right = box(after);
    if (!left || !right || (left.width === 0 && right.width === 0))
      return point;
    // On a word, that word; in the space, the nearer edge.
    const nearer =
      x >= right.left || right.left - x < x - left.right ? after : before;
    return { line: point.line, offset: nearer.charStart };
  }

  /**
   * A point while dragging: off the lines (between them, past the block), the line above or
   * below the gesture's own, so the choice stops at its edge (BR-1).
   */
  private dragPointAt(x: number, y: number, at: number): TextPoint | null {
    const point = this.wordPointAt(x, y);
    if (point) return point;
    const element = this.lineOf(at);
    if (typeof element?.getBoundingClientRect !== 'function') return null;
    const box = element.getBoundingClientRect();
    if (y > box.bottom) return { line: at + 1, offset: 0 };
    if (y < box.top) return { line: at - 1, offset: 0 };
    return null;
  }

  /** A restricted segment (KBC-106) never takes part in a choice (KBC-115 BR-2). */
  private hidden(line: number): boolean {
    const segment = this.lines()[line]?.segment;
    return (
      segment === undefined || this.segments()[segment]?.restricted === true
    );
  }

  /**
   * Shift+click with the panel open (KBC-115 FR-3): the choice stretches from its anchor to
   * the word, within its segment; false when there is nothing open to stretch.
   */
  private stretchTo(point: TextPoint): boolean {
    const selection = this.desk.selection();
    const anchor = this.desk.anchor();
    if (!selection || anchor === null) return false;
    const at = this.lines().findIndex(
      (line) => line.segment === selection.segment,
    );
    const gesture =
      at < 0 ? null : gestureTo(this.lines(), { line: at, anchor }, point);
    if (!gesture) return false;
    this.document.getSelection()?.removeAllRanges();
    this.commit(gesture, true);
    return true;
  }

  /** The words chosen go to the panel: a new choice, or the open one stretched (BR-3, BR-4). */
  private commit(gesture: Gesture, stretch: boolean): void {
    this.gesture.set(null);
    this.byKeys = false;
    const line = this.lines()[gesture.line];
    if (!line || this.hidden(gesture.line)) return;
    this.chosenFrom = 'text';
    if (
      stretch &&
      this.desk.extend(line.segment, gesture.focus, {
        anchor: gesture.anchor,
        clamped: gesture.clamped,
      }) !== null
    )
      return;
    this.desk.choose(line.segment, Math.min(gesture.anchor, gesture.focus), {
      to: Math.max(gesture.anchor, gesture.focus),
      anchor: gesture.anchor,
      clamped: gesture.clamped,
    });
  }

  /** A press on a word, by whoever corrects: it may become a drag (FR-1, FR-2). */
  private startPress(event: PointerEvent): void {
    // A second finger, or another pointer while one drags: the drag goes on (IMP-1).
    if (event.isPrimary === false) return;
    if (this.press?.selecting && this.press.pointerId !== event.pointerId)
      return;
    this.swallowClick = false;
    this.endPress();
    if (!this.pressable(event)) return;
    const from = this.wordPointAt(event.clientX, event.clientY);
    if (!from || this.hidden(from.line)) return;
    this.wordsFor(from.line);
    const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    const press: Press = {
      pointerId: event.pointerId,
      touch,
      x: event.clientX,
      y: event.clientY,
      from,
      selecting: false,
      timer: null,
    };
    if (touch)
      press.timer = setTimeout(() => this.beginDrag(press), LONG_PRESS_MS);
    this.press = press;
  }

  /** A main button or a finger, with no Shift (Shift+click stretches), on a ready text. */
  private pressable(event: PointerEvent): boolean {
    return (
      this.canCorrect &&
      this.state() === 'ready' &&
      event.button === 0 &&
      event.isPrimary !== false &&
      !event.shiftKey
    );
  }

  /** A line whose words are not here yet gets them now: the drag needs them. */
  private wordsFor(index: number): void {
    const line = this.lines()[index];
    if (line?.words !== null) return;
    this.source.words
      .load(wordsPageOf(line.segment))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** The drag starts: the word under the press is chosen alone, and painted (UP-01). */
  private beginDrag(press: Press): void {
    if (this.press !== press) return;
    press.timer = null;
    press.selecting = true;
    this.byKeys = false;
    this.document.getSelection()?.removeAllRanges();
    const body = this.body().nativeElement;
    if (typeof body.setPointerCapture === 'function')
      try {
        body.setPointerCapture(press.pointerId);
      } catch {
        // The pointer is gone already: the release ends the drag as well.
      }
    this.dragTo(press, press.from);
  }

  private dragTo(press: Press, point: TextPoint): void {
    const anchor = wordAt(this.lines()[press.from.line], press.from.offset);
    if (anchor === null) return;
    this.gesture.set(
      gestureTo(this.lines(), { line: press.from.line, anchor }, point),
    );
  }

  protected moved(event: PointerEvent): void {
    const press = this.press;
    if (press?.pointerId !== event.pointerId) return;
    if (!press.selecting && !this.dragStarts(press, event)) return;
    const point = this.dragPointAt(
      event.clientX,
      event.clientY,
      press.from.line,
    );
    if (point) this.dragTo(press, point);
  }

  /**
   * Whether a move starts the drag: a mouse moved past its slop does; a finger moved before
   * its long press scrolls the block, as before, and ends the press.
   */
  private dragStarts(press: Press, event: PointerEvent): boolean {
    const far = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (press.touch) {
      if (far > TOUCH_SLOP_PX) this.endPress();
      return false;
    }
    if (far <= MOUSE_SLOP_PX) return false;
    this.beginDrag(press);
    return true;
  }

  protected released(event: PointerEvent): void {
    const press = this.press;
    if (press?.pointerId !== event.pointerId) return;
    const gesture = this.gesture();
    this.endPress();
    if (!press.selecting) return;
    // The click that follows a drag is the drag's end, not a click on a word.
    this.swallowClick = true;
    const line = this.lines()[press.from.line];
    if (gesture) this.commit(gesture, false);
    else if (line)
      this.pick(line, { start: press.from.offset, end: press.from.offset });
  }

  /** Cancelled, or the capture lost with no release: nothing is chosen, the mark goes. */
  protected cancelled(event: PointerEvent): void {
    if (this.press?.pointerId !== event.pointerId) return;
    this.endPress();
  }

  /**
   * The second press of a double or triple click selects as the browser does (IMP-3): the
   * panel the first click opened closes untouched, and the focus stays on the text.
   */
  protected mousePressed(event: MouseEvent): void {
    if (event.detail < 2) return;
    this.endPress();
    if (this.openedByClick && !this.desk.dirty()) this.desk.close();
    this.openedByClick = false;
  }

  /** Only the block's own capture ends a drag: a line's implicit one bubbles here too. */
  protected lostCapture(event: PointerEvent): void {
    if (event.target === this.body().nativeElement) this.cancelled(event);
  }

  /** Every way a press ends takes its mark away and lets the block scroll again (IMP-1). */
  private endPress(): void {
    const press = this.press;
    if (!press) return;
    if (press.timer !== null) clearTimeout(press.timer);
    this.press = null;
    if (!this.byKeys) this.gesture.set(null);
    const body = this.body().nativeElement;
    if (
      typeof body.hasPointerCapture === 'function' &&
      body.hasPointerCapture(press.pointerId)
    )
      body.releasePointerCapture(press.pointerId);
  }

  /**
   * While a single press is on a word, the browser neither selects text nor opens its menu;
   * a double or triple click ends the press first, so it still selects for copying.
   */
  protected heldBack(event: Event): void {
    if (this.press) event.preventDefault();
  }

  /** Shift+→ / Shift+← choose words from the keyboard; Esc gives up (KBC-115 FR-4). */
  protected keyOnText(event: KeyboardEvent): void {
    const arrow =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (
      arrow !== 0 &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      this.canCorrect &&
      this.state() === 'ready'
    ) {
      event.preventDefault();
      this.stepByKey(arrow);
      return;
    }
    if (event.key === 'Escape' && this.press?.selecting) {
      // Esc during a drag gives up, as with the keys (QA-2): the release opens nothing.
      event.preventDefault();
      this.endPress();
      this.swallowClick = true;
      return;
    }
    if (event.key === 'Escape' && this.byKeys) {
      event.preventDefault();
      this.giveUpKeys();
      return;
    }
    this.scrolledByKey(event);
  }

  /** Shift released: what the arrows chose goes to the panel (FR-4). */
  protected keyUpOnText(event: KeyboardEvent): void {
    if (event.key !== 'Shift' || !this.byKeys) return;
    const gesture = this.gesture();
    if (!gesture) {
      this.byKeys = false;
      return;
    }
    const open = this.desk.selection();
    const segment = this.lines()[gesture.line]?.segment;
    this.commit(gesture, open !== null && open.segment === segment);
  }

  /** The focus left the text halfway: nothing is chosen. */
  protected leftText(): void {
    if (this.byKeys) this.giveUpKeys();
  }

  private giveUpKeys(): void {
    this.byKeys = false;
    this.gesture.set(null);
  }

  private stepByKey(direction: 1 | -1): void {
    const current = this.byKeys ? this.gesture() : this.keyStart(direction);
    if (!current) return;
    this.byKeys = true;
    const next = gestureStep(this.lines(), current, direction) ?? current;
    this.gesture.set(next);
    const offsets = gestureOffsets(this.lines(), next);
    const text = offsets
      ? (this.lines()[next.line]?.text ?? '').slice(offsets.start, offsets.end)
      : '';
    this.desk.say(next.clamped ? insideSaid() : text);
  }

  /**
   * Where Shift+arrows start (FR-4): the open choice, with its anchor; else the word chosen
   * last; else the word being said; else the first word of the text.
   */
  private keyStart(direction: 1 | -1): Gesture | null {
    return this.openGesture(direction) ?? this.freshGesture();
  }

  /**
   * The open choice as a gesture: its anchor stays, its other end moves. An anchor in the
   * middle (after Incluir on both sides) goes to the end behind the arrow, so nothing is lost.
   */
  private openGesture(direction: 1 | -1): Gesture | null {
    const open = this.desk.selection();
    const anchor = this.desk.anchor();
    if (!open || anchor === null) return null;
    const line = this.lines().findIndex((one) => one.segment === open.segment);
    const words = this.desk.words();
    const first = words[0]?.position;
    const last = words.at(-1)?.position;
    if (line < 0 || first === undefined || last === undefined) return null;
    const atEnd = anchor === first || anchor === last;
    const from = atEnd ? anchor : direction === 1 ? first : last;
    return {
      line,
      anchor: from,
      focus: from === first ? last : first,
      clamped: false,
    };
  }

  private freshGesture(): Gesture | null {
    const lines = this.lines();
    const at = (line: number, position: number | null): Gesture | null =>
      line >= 0 && position !== null && !this.hidden(line)
        ? { line, anchor: position, focus: position, clamped: false }
        : null;
    const last = this.desk.lastChosen();
    if (last) {
      const line = lines.findIndex((one) => one.segment === last.segment);
      const known = placedWords(lines[line]).some(
        (word) => word.position === last.position,
      );
      const found = known ? at(line, last.position) : null;
      if (found) return found;
    }
    const spoken = this.spoken();
    if (spoken && !spoken.whole) {
      const found = at(spoken.line, wordAt(lines[spoken.line], spoken.start));
      if (found) return found;
    }
    const line = lines.findIndex(
      (one, index) => placedWords(one).length > 0 && !this.hidden(index),
    );
    return at(line, placedWords(lines[line])[0]?.position ?? null);
  }

  /** The words being chosen, painted as the chosen ones are (NFR-1). */
  private gestureRange(): Range | null {
    const gesture = this.gesture();
    if (!gesture) return null;
    const offsets = gestureOffsets(this.lines(), gesture);
    return offsets
      ? this.rangeOf({ line: gesture.line, ...offsets, whole: false })
      : null;
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
    this.desk.choose(line.segment, first, { to: last ?? first });
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
    this.startPress(event);
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
    this.destroyRef.onDestroy(() => {
      stops.forEach((stop) => stop());
      this.endPress();
    });
  }

  /**
   * Only whoever corrects, once the text is there, gets a touchmove that may stop the scroll
   * while a finger chooses words (KBC-115 FR-2). Not passive, so the browser waits for it on
   * every touch scroll of the block: everyone else keeps the passive listeners only (BR-5).
   */
  private holdScrollWhileChoosing(): void {
    let stop: (() => void) | null = null;
    afterRenderEffect(() => {
      if (stop || this.state() !== 'ready') return;
      stop = this.renderer.listen(
        this.body().nativeElement,
        'touchmove',
        (event: TouchEvent) => {
          if (this.press?.selecting) event.preventDefault();
        },
        { passive: false },
      );
    });
    this.destroyRef.onDestroy(() => stop?.());
  }
}

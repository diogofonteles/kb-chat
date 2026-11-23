/** The class of a line after the one heard: fainter (v2 tLine). */
const UPCOMING = 'upcoming';

/**
 * The most lines set in one task of the background pass. Each is a style recalculation
 * and, for assistive technology, a change to describe again: ~200 stay well inside a
 * frame at 4x CPU, where ~1 500 at once took ~300 ms (KBC-163).
 */
const CHUNK = 200;

/** Runs `task` later, off the frame that asked; returns how to cancel it. */
export type Later = (task: () => void) => () => void;

/** The lines at or after `from` and up to `to`, as indexes (inclusive). */
interface Span {
  readonly from: number;
  readonly to: number;
}

/**
 * Marks the lines after the one heard (KBC-163). A sibling selector, or a class bound by
 * the template, would restyle, repaint and describe again to assistive technology every
 * line after it in one frame: ~1 500 on the first play of a 2 h transcript, past the
 * 200 ms a click may take (KBC-038 NFR-2). Only the lines whose state changes need a
 * write (those between the line heard before and now); of those, the ones that can show
 * are set at once, the others in small tasks after the frame:
 * - the lines in the list's view or half a view from it, as an IntersectionObserver
 *   reports them;
 * - the lines where the list is going ({@link settle}), before it scrolls, since the
 *   observer only reports them after the frame that shows them.
 * Without an observer, every line is set at once.
 */
export class UpcomingLines {
  private lines: readonly HTMLElement[] = [];
  /** What each line wears now. */
  private faint: boolean[] = [];
  /** The lines in the list's view or half a view away from it. */
  private readonly near = new Set<number>();
  /** Where the list went last: kept right until it goes elsewhere. */
  private landing: Span | null = null;
  /** The lines that may be wrong, for the background pass. */
  private stale: Span | null = null;
  private cancelPass: (() => void) | null = null;
  private observer: IntersectionObserver | null = null;
  private heard = -1;

  constructor(
    private readonly Observer: typeof IntersectionObserver | undefined,
    private readonly later: Later,
  ) {}

  /** A new set of lines, in the list that scrolls them. */
  watch(lines: readonly HTMLElement[], list: HTMLElement | undefined): void {
    this.stop();
    this.lines = lines;
    this.faint = lines.map((line) => line.classList.contains(UPCOMING));
    if (this.Observer && list) this.observe(lines, list, this.Observer);
    // Lines kept from before may wear an old state.
    this.makeStale({ from: 0, to: lines.length - 1 });
  }

  private observe(
    lines: readonly HTMLElement[],
    list: HTMLElement,
    Observer: typeof IntersectionObserver,
  ): void {
    const indexOf = new Map(lines.map((line, at) => [line as Element, at]));
    this.observer = new Observer(
      (entries) => {
        for (const entry of entries) {
          const at = indexOf.get(entry.target);
          if (at === undefined) continue;
          if (!entry.isIntersecting) this.near.delete(at);
          else {
            this.near.add(at);
            this.mark(at);
          }
        }
      },
      { root: list, rootMargin: '50% 0px' },
    );
    for (const line of lines) this.observer.observe(line);
  }

  /** The line heard now (−1: none, and no line is fainter). */
  show(heard: number): void {
    if (heard !== this.heard) {
      const changed = changedBetween(this.heard, heard, this.lines.length);
      this.heard = heard;
      if (changed) this.makeStale(changed);
    }
    if (!this.observer) {
      this.markSpan(this.stale);
      this.stale = null;
      return;
    }
    for (const at of this.near) this.mark(at);
    this.markSpan(this.landing);
  }

  /**
   * The list is about to scroll over the lines `from` to `to` (its way and where it lands,
   * with half a view either side): set them now, in the frame that scrolls, and keep them
   * right until it scrolls elsewhere.
   */
  settle(heard: number, from: number, to: number): void {
    this.landing = { from, to };
    this.show(heard);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.near.clear();
    this.landing = null;
    this.stale = null;
    this.cancelPass?.();
    this.cancelPass = null;
  }

  private makeStale(span: Span): void {
    if (span.from > span.to) return;
    this.stale = this.stale
      ? {
          from: Math.min(this.stale.from, span.from),
          to: Math.max(this.stale.to, span.to),
        }
      : span;
    if (!this.cancelPass && this.observer !== null) this.schedulePass();
  }

  private schedulePass(): void {
    this.cancelPass = this.later(() => {
      this.cancelPass = null;
      this.pass();
    });
  }

  /** Sets up to {@link CHUNK} stale lines, and comes back for the rest. */
  private pass(): void {
    const stale = this.stale;
    if (!stale) return;
    let changes = 0;
    let at = stale.from;
    for (; at <= stale.to && changes < CHUNK; at++)
      if (this.mark(at)) changes++;
    this.stale = at > stale.to ? null : { from: at, to: stale.to };
    if (this.stale) this.schedulePass();
  }

  private markSpan(span: Span | null): void {
    if (!span) return;
    const last = Math.min(span.to, this.lines.length - 1);
    for (let at = Math.max(0, span.from); at <= last; at++) this.mark(at);
  }

  /** Sets one line; whether it changed. */
  private mark(at: number): boolean {
    const want = this.heard >= 0 && at > this.heard;
    if (this.faint[at] === want || !this.lines[at]) return false;
    this.faint[at] = want;
    this.lines[at].classList.toggle(UPCOMING, want);
    return true;
  }
}

/** The lines whose state differs between two lines heard (−1: none). */
function changedBetween(
  before: number,
  now: number,
  count: number,
): Span | null {
  if (before === now) return null;
  // From none heard (or to none), every line after the one heard changes.
  if (before < 0 || now < 0)
    return { from: Math.max(before, now) + 1, to: count - 1 };
  return { from: Math.min(before, now) + 1, to: Math.max(before, now) };
}

/**
 * The lines whose box meets the band from `top` to `bottom`, in the list's scroll
 * coordinates; null when none does. The lines are in order down the list, so it searches
 * by halves; a hidden line (folded into the one before) has no box and is passed over.
 */
export function linesWithin(
  lines: readonly HTMLElement[],
  top: number,
  bottom: number,
): Span | null {
  const firstBelow = (edge: (line: HTMLElement) => boolean): number => {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      let shown = middle;
      while (shown < high && lines[shown]?.hidden) shown++;
      if (shown === high) high = middle;
      else if (edge(lines[shown] as HTMLElement)) high = middle;
      else low = shown + 1;
    }
    return low;
  };
  const from = firstBelow((line) => line.offsetTop + line.offsetHeight > top);
  const to = firstBelow((line) => line.offsetTop >= bottom) - 1;
  return from <= to ? { from, to } : null;
}

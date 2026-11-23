/** The class of a line after the one heard: fainter (v2 tLine). */
const UPCOMING = 'upcoming';

/**
 * The lines either side of the one heard set in its own frame: where the list goes when it
 * follows, before the observer has seen them (about a screen of the desktop list).
 */
const AROUND_HEARD = 16;

/**
 * Marks the lines after the one heard (KBC-163). A sibling selector, or a class bound by
 * the template, would restyle, repaint and describe again to assistive technology every
 * line after it in one frame: ~1 500 on the first play of a 2 h transcript, past the
 * 200 ms a click may take (KBC-038 NFR-2). Here only the lines in the list's view or half
 * a view away from it are kept right, with those around the line heard; the others are set
 * as they come near the view, before they show. Without an observer, every line is set.
 */
export class UpcomingLines {
  private lines: readonly HTMLElement[] = [];
  /** What each line wears now. */
  private faint: boolean[] = [];
  /** The lines in the list's view or half a view away from it. */
  private readonly near = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private heard = -1;

  constructor(
    private readonly Observer: typeof IntersectionObserver | undefined,
  ) {}

  /** A new set of lines, in the list that scrolls them. */
  watch(lines: readonly HTMLElement[], list: HTMLElement | undefined): void {
    this.stop();
    this.lines = lines;
    this.faint = lines.map((line) => line.classList.contains(UPCOMING));
    if (!this.Observer || !list) return;
    const indexOf = new Map(lines.map((line, at) => [line as Element, at]));
    this.observer = new this.Observer(
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
    this.heard = heard;
    if (!this.observer) {
      for (let at = 0; at < this.lines.length; at++) this.mark(at);
      return;
    }
    for (const at of this.near) this.mark(at);
    const around = Math.max(0, heard);
    const last = Math.min(this.lines.length - 1, around + AROUND_HEARD);
    for (let at = Math.max(0, around - AROUND_HEARD); at <= last; at++)
      this.mark(at);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.near.clear();
  }

  private mark(at: number): void {
    const want = this.heard >= 0 && at > this.heard;
    if (this.faint[at] === want) return;
    this.faint[at] = want;
    this.lines[at]?.classList.toggle(UPCOMING, want);
  }
}

/** How far an arrow key moves the page, as the browsers do (about 40 px). */
const LINE_PX = 40;

/**
 * The media pages scroll in their own row, not the document: right after a page opens the
 * focus is on the body, and PageDown, Space, the arrows, Home and End would move nothing
 * (verify-2, 2026-11-17). With nothing focused, they move the page's own scroller, as they
 * would the document. A key someone else took (a menu, a field, a dialog) is left alone.
 */
export function scrollPageByKey(
  scroller: HTMLElement,
  event: KeyboardEvent,
): void {
  const doc = scroller.ownerDocument;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const target = event.target;
  if (target !== doc.body && target !== doc.documentElement) return;
  if (doc.querySelector('dialog[open]')) return;
  const page = Math.max(scroller.clientHeight - LINE_PX, LINE_PX);
  const top = topFor(event, scroller, page);
  if (top === null) return;
  event.preventDefault();
  const reduce =
    doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
    true;
  scroller.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}

/** Where the page is, a page's height, its length and whether Shift is down. */
interface Place {
  readonly at: number;
  readonly page: number;
  readonly end: number;
  readonly shift: boolean;
}

/** Where each key takes the page. */
const MOVES: Readonly<Record<string, (place: Place) => number>> = {
  PageDown: ({ at, page }) => at + page,
  PageUp: ({ at, page }) => at - page,
  ' ': ({ at, page, shift }) => (shift ? at - page : at + page),
  ArrowDown: ({ at }) => at + LINE_PX,
  ArrowUp: ({ at }) => at - LINE_PX,
  End: ({ end }) => end,
  Home: () => 0,
};

function topFor(
  event: KeyboardEvent,
  scroller: HTMLElement,
  page: number,
): number | null {
  const move = Object.hasOwn(MOVES, event.key) ? MOVES[event.key] : undefined;
  return move
    ? move({
        at: scroller.scrollTop,
        page,
        end: scroller.scrollHeight,
        shift: event.shiftKey,
      })
    : null;
}

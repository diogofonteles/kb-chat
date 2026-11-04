/**
 * The media pages scroll in their own row (above the mini-player): the element that takes
 * the focus comes fully into view, in every browser (WCAG 2.4.11, KBC-041 FR-11). Not what
 * is being pressed: the page would move before the release, and the click would be lost.
 */
export function keepFocusedInView(event: FocusEvent): void {
  if (event.target instanceof HTMLElement && !event.target.matches(':active'))
    event.target.scrollIntoView?.({ block: 'nearest' });
}

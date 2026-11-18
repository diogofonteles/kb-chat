import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  inject,
  input,
} from '@angular/core';

/** The least gap an overlay keeps from the edges of the screen. */
export const SCREEN_MARGIN_PX = 8;
/** The gap between the trigger and its overlay. */
const GAP_PX = 6;

export type OverlayAlign = 'start' | 'end';
export type OverlaySide = 'below' | 'above';

export interface OverlayBox {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface OverlayRequest {
  readonly anchor: OverlayBox;
  /** The panel's natural size. */
  readonly size: Size;
  readonly viewport: Size;
  readonly align: OverlayAlign;
  readonly side: OverlaySide;
}

export interface OverlayPlacement {
  readonly top: number;
  readonly left: number;
  readonly maxHeight: number;
  readonly maxWidth: number;
  readonly side: OverlaySide;
}

/** The side it opens on, and the room it has there. */
function chooseSide({ anchor, size, viewport, side }: OverlayRequest): {
  side: OverlaySide;
  room: number;
} {
  const room = {
    below: viewport.height - anchor.bottom - GAP_PX - SCREEN_MARGIN_PX,
    above: anchor.top - GAP_PX - SCREEN_MARGIN_PX,
  };
  const other: OverlaySide = side === 'below' ? 'above' : 'below';
  const flip = size.height > room[side] && room[other] > room[side];
  const chosen = flip ? other : side;
  return { side: chosen, room: Math.max(0, room[chosen]) };
}

/** The left edge: under the trigger's start or end, shifted to stay inside the viewport. */
function leftEdge({ anchor, size, viewport, align }: OverlayRequest): {
  left: number;
  maxWidth: number;
} {
  const maxWidth = Math.max(0, viewport.width - 2 * SCREEN_MARGIN_PX);
  const width = Math.min(size.width, maxWidth);
  const wanted = align === 'start' ? anchor.left : anchor.right - width;
  const highest = viewport.width - SCREEN_MARGIN_PX - width;
  const left = Math.min(Math.max(SCREEN_MARGIN_PX, wanted), highest);
  return { left: Math.max(SCREEN_MARGIN_PX, left), maxWidth };
}

/**
 * Where an overlay goes next to its trigger (decision D5 of redesign-v2): on the preferred
 * side, flipped to the other one when it does not fit there and fits better there, then
 * shifted sideways so it never leaves the viewport. Pure, for the tests.
 */
export function placeOverlay(request: OverlayRequest): OverlayPlacement {
  const { side, room } = chooseSide(request);
  const whole = Math.max(0, request.viewport.height - 2 * SCREEN_MARGIN_PX);
  if (request.size.height > room && room < whole) {
    // Taller than the room on either side: it slides to stay whole on the screen, over its
    // trigger if need be, instead of scrolling inside (D5: a menu is never cut).
    const height = Math.min(request.size.height, whole);
    const wanted =
      side === 'below'
        ? request.anchor.bottom + GAP_PX
        : request.anchor.top - GAP_PX - height;
    const lowest = request.viewport.height - SCREEN_MARGIN_PX - height;
    const top = Math.max(SCREEN_MARGIN_PX, Math.min(wanted, lowest));
    return { top, ...leftEdge(request), maxHeight: whole, side };
  }
  const height = Math.min(request.size.height, room);
  const top =
    side === 'below'
      ? request.anchor.bottom + GAP_PX
      : Math.max(SCREEN_MARGIN_PX, request.anchor.top - GAP_PX - height);
  return { top, ...leftEdge(request), maxHeight: room, side };
}

export interface AnchorOptions {
  readonly align?: OverlayAlign;
  readonly side?: OverlaySide;
  /** The panel at least as wide as the trigger (a select list). */
  readonly matchWidth?: boolean;
  /** Below this width the panel is only lifted, never positioned: its CSS makes it a sheet. */
  readonly sheetBelow?: number | null;
}

/** Whether the browser has the popover API (jsdom in the unit tests does not). */
const hasPopover = (element: HTMLElement): boolean =>
  typeof element.showPopover === 'function';

const PLACED = [
  'top',
  'left',
  'right',
  'bottom',
  'max-height',
  'max-width',
  'min-width',
];

/** The panel's own CSS height limit (Infinity when it has none). */
function cssMaxHeight(panel: HTMLElement, view: Window): number {
  // Measured without the last placement's limit, which would hide a flip.
  panel.style.removeProperty('max-height');
  const limit = Number.parseFloat(view.getComputedStyle(panel).maxHeight);
  return Number.isFinite(limit) ? limit : Infinity;
}

/** Writes a placement on the panel, its height under its own CSS limit too. */
function apply(
  panel: HTMLElement,
  where: OverlayPlacement,
  cssMax: number,
): void {
  Object.assign(panel.style, {
    top: `${where.top}px`,
    left: `${where.left}px`,
    right: 'auto',
    bottom: 'auto',
    maxHeight: `${Math.min(where.maxHeight, cssMax)}px`,
    maxWidth: `${where.maxWidth}px`,
  });
  panel.dataset['side'] = where.side;
}

/** Puts `panel` where `placeOverlay` says (or leaves it to its sheet CSS on a phone). */
function place(
  panel: HTMLElement,
  anchor: HTMLElement,
  options: AnchorOptions,
): void {
  const view = panel.ownerDocument.defaultView;
  if (!view) return;
  const sheet =
    options.sheetBelow != null && view.innerWidth < options.sheetBelow;
  panel.classList.toggle('ui-overlay--sheet', sheet);
  if (sheet) {
    for (const prop of PLACED) panel.style.removeProperty(prop);
    return;
  }
  const box = anchor.getBoundingClientRect();
  if (options.matchWidth) panel.style.minWidth = `${box.width}px`;
  const cssMax = cssMaxHeight(panel, view);
  const viewport = panel.ownerDocument.documentElement.clientWidth;
  const where = placeOverlay({
    anchor: box,
    size: {
      width: panel.offsetWidth,
      height: Math.min(panel.scrollHeight, cssMax),
    },
    viewport: { width: viewport, height: view.innerHeight },
    align: options.align ?? 'start',
    side: options.side ?? 'below',
  });
  apply(panel, where, cssMax);
}

/**
 * Lifts `panel` into the top layer (the popover API) and keeps it anchored to `anchor`: no
 * container's `overflow`, `transform` or stacking context can clip or cover it. Returns the
 * function that takes it out again.
 */
export function anchorOverlay(
  panel: HTMLElement,
  anchor: HTMLElement,
  options: AnchorOptions = {},
): () => void {
  const view = panel.ownerDocument.defaultView;
  if (hasPopover(panel)) {
    if (!panel.hasAttribute('popover')) panel.setAttribute('popover', 'manual');
    if (!panel.matches(':popover-open')) panel.showPopover();
  }
  panel.classList.add('ui-overlay');
  const follow = (): void => place(panel, anchor, options);
  follow();
  // Scrolling any container or resizing moves the trigger: the panel follows it (its own
  // list scrolling does not).
  const scrolled = (event: Event): void => {
    if (!(event.target instanceof Node && panel.contains(event.target)))
      follow();
  };
  view?.addEventListener('resize', follow);
  view?.addEventListener('scroll', scrolled, true);
  const grown = followSize(panel, follow);
  return () => {
    grown();
    view?.removeEventListener('resize', follow);
    view?.removeEventListener('scroll', scrolled, true);
    if (hasPopover(panel) && panel.matches(':popover-open'))
      panel.hidePopover();
    panel.classList.remove('ui-overlay', 'ui-overlay--sheet');
  };
}

/**
 * Content that comes after the first placement (a menu's items, a note's alert) grows the
 * panel: placed again, it still fits the screen whole. Returns the function that stops it.
 */
function followSize(panel: HTMLElement, follow: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => undefined;
  const grown = new ResizeObserver(follow);
  grown.observe(panel);
  return () => grown.disconnect();
}

/** Whether a click landed outside the panel's box (its backdrop belongs to the panel). */
export function outsideBox(panel: HTMLElement, event: MouseEvent): boolean {
  const box = panel.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
}

/**
 * The overlay layer for a popover or list that exists only while open (`@if`): it rises to
 * the top layer anchored to `uiOverlay` (its trigger) when it renders and leaves with it.
 *
 * `<div class="popover" [uiOverlay]="chip" overlayAlign="start">…</div>`
 */
@Directive({ selector: '[uiOverlay]' })
export class UiOverlay {
  readonly anchor = input.required<HTMLElement>({ alias: 'uiOverlay' });
  readonly overlayAlign = input<OverlayAlign>('start');
  readonly overlaySide = input<OverlaySide>('below');
  readonly overlayMatchWidth = input(false);
  /** Below this width the panel's CSS makes it a sheet: lifted, not positioned. */
  readonly overlaySheetBelow = input<number | null>(null);

  constructor() {
    const panel = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let release: (() => void) | null = null;
    afterNextRender(() => {
      release = anchorOverlay(panel, this.anchor(), {
        align: this.overlayAlign(),
        side: this.overlaySide(),
        matchWidth: this.overlayMatchWidth(),
        sheetBelow: this.overlaySheetBelow(),
      });
    });
    inject(DestroyRef).onDestroy(() => release?.());
  }
}

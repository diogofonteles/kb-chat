import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import { desktop } from './shell-helpers.js';

/**
 * Scrolling as a person does it, at 1440 and 390, in Chromium and in WebKit (KBC-125: after
 * the v2 merge no text page could be scrolled). Each check scrolls over a region and asserts
 * that what is under the pointer moved on screen, whatever element turns out to scroll.
 */

/** More than this many pixels is a move, not a rounding. */
export const MOVED = 50;

/** A short window, so the content of a screen that fits at 900 has something to scroll. */
export async function shortWindow(page: Page, height = 560): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  await page.setViewportSize({ width, height });
}

/** The middle of the part of `region` that is on screen. */
export async function middleOf(
  page: Page,
  region: Locator,
): Promise<{ x: number; y: number }> {
  const box = await region.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('the region is not on screen');
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, viewport.height);
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round((top + bottom) / 2),
  };
}

/** Marks the element under `point`; its top on screen tells whether the text moved. */
async function probe(
  page: Page,
  point: { x: number; y: number },
): Promise<() => Promise<number>> {
  await page.evaluate(({ x, y }) => {
    document
      .querySelectorAll('[data-scroll-probe]')
      .forEach((old) => old.removeAttribute('data-scroll-probe'));
    document.elementFromPoint(x, y)?.setAttribute('data-scroll-probe', '');
  }, point);
  const marked = page.locator('[data-scroll-probe]');
  return async () => (await marked.boundingBox())?.y ?? Number.NaN;
}

/** The longest single stroke of the finger, as a thumb drags on a phone. */
const STROKE = 200;
/** The finger's samples per stroke: a touchmove every few pixels, as a screen reports them. */
const STEPS = 10;
/** Longer than Chromium's 40 ms after which a still pointer has no velocity left to fling. */
const REST_MS = 100;

/** One stroke: the finger down on `point`, `length` pixels up, still, then lifted. */
async function stroke(
  cdp: CDPSession,
  point: { x: number; y: number },
  length: number,
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y }],
  });
  for (let step = 1; step <= STEPS; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: point.x, y: Math.round(point.y - (length * step) / STEPS) },
      ],
    });
  }
  // The finger rests before it lifts, so no fling carries the page on after the swipe (a
  // check that scrolls back to the top right after it would be undone by the momentum).
  await new Promise((resolve) => setTimeout(resolve, REST_MS));
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

/**
 * A finger put down on `point` and dragged up by `dy` pixels (in strokes of at most STROKE,
 * each lifted at its end), through the browser's touch input: touchstart, touchmove, touchend.
 * Chromium's `Input.synthesizeScrollGesture` with a touch source moves nothing in CI's
 * headless Linux, not even on a blank page with one scrolling box (it does on macOS), so it
 * cannot tell a page that scrolls from one that does not; real touch events go through the
 * same hit test, `touch-action` and scroll chain as a person's thumb.
 */
export async function touchSwipe(
  page: Page,
  point: { x: number; y: number },
  dy: number,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    // The finger stays on screen: a stroke never goes above the top of the viewport.
    const longest = Math.min(STROKE, Math.max(point.y - 4, 40));
    for (let left = dy; left > 0; left -= longest) {
      await stroke(cdp, point, Math.min(left, longest));
    }
  } finally {
    await cdp.detach();
  }
}

/**
 * A wheel on desktop; on a phone a finger dragged up (real touch events, see touchSwipe) or,
 * in WebKit, which has no synthetic touch, the wheel over the same point (its 390 project is
 * a touch screen without the mobile flag, which would refuse the wheel).
 */
export async function scrollOver(
  page: Page,
  point: { x: number; y: number },
  dy: number,
): Promise<void> {
  const chromium =
    page.context().browser()?.browserType().name() === 'chromium';
  if (desktop(page) || !chromium) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, dy);
    return;
  }
  await touchSwipe(page, point, dy);
}

/** Scrolls down over `region` and expects its content to move up by more than MOVED. */
export async function expectScrolls(
  page: Page,
  region: Locator,
  dy = 400,
): Promise<void> {
  await expect(region).toBeVisible();
  const point = await middleOf(page, region);
  const top = await probe(page, point);
  const before = await top();
  await scrollOver(page, point, dy);
  await expect.poll(top).toBeLessThan(before - MOVED);
}

/**
 * The keyboard on desktop: with the focus on `start` (a non-editable element), Page Down and
 * Space move the text up, Page Up and Shift+Space bring it back down.
 */
export async function expectKeyboardScrolls(
  page: Page,
  start: Locator,
): Promise<void> {
  if (!desktop(page)) return;
  await start.click();
  const point = await middleOf(page, start);
  const top = await probe(page, point);
  const before = await top();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Space');
  await expect.poll(top).toBeLessThan(before - MOVED);
  const down = await top();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('Shift+Space');
  await expect.poll(top).toBeGreaterThan(down + MOVED);
}

/** Waits until nothing on the page is still scrolling (a keyboard scroll is animated). */
export async function scrollSettled(page: Page): Promise<void> {
  const positions = () =>
    page.evaluate(() =>
      [document.scrollingElement, ...Array.from(document.querySelectorAll('*'))]
        .filter((element): element is Element => element !== null)
        .map((element) => element.scrollTop)
        .join(','),
    );
  let last = '';
  await expect
    .poll(async () => {
      const now = await positions();
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
}

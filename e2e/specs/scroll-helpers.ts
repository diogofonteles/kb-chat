import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import { desktop } from './shell-helpers.js';

/**
 * Scrolling as a person does it (KBC-125, KBC-129): the wheel and the keyboard on a
 * desktop, a finger on a phone, asserting the text under the pointer moved on screen,
 * whatever element turns out to be the scroller. The same checks as content-scroll.spec.
 */

/** A short window where the fixture's text would otherwise fit on one screen. */
export async function shortWindow(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  await page.setViewportSize({ width, height: 560 });
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

interface Probe {
  /** The top on screen of the element under the pointer: text that scrolls moves it. */
  readonly top: () => Promise<number>;
  /** The box around it with more text than fits is already scrolled to its end. */
  readonly atEnd: boolean;
}

/** More text than fits by at least this much is something to scroll. */
const OVERFLOW = 50;

/**
 * Marks the element under `point` and reads where the text around it stands, once the box
 * around it holds more than fits (the text may still be loading).
 */
export async function probeAt(
  page: Page,
  point: { x: number; y: number },
): Promise<Probe> {
  const read = () =>
    page.evaluate(
      ({ x, y, overflow }) => {
        document
          .querySelectorAll('[data-scroll-probe]')
          .forEach((old) => old.removeAttribute('data-scroll-probe'));
        const element = document.elementFromPoint(x, y);
        element?.setAttribute('data-scroll-probe', '');
        let box = element;
        while (box && box.scrollHeight - box.clientHeight <= overflow)
          box = box.parentElement;
        if (!box || box === document.documentElement) return null;
        return box.scrollTop + box.clientHeight >= box.scrollHeight - overflow;
      },
      { ...point, overflow: OVERFLOW },
    );
  await expect
    .poll(read, {
      message: 'the text under the pointer fits: nothing to scroll',
    })
    .not.toBeNull();
  const atEnd = (await read()) ?? false;
  const probe = page.locator('[data-scroll-probe]');
  return {
    top: async () => (await probe.boundingBox())?.y ?? Number.NaN,
    atEnd,
  };
}

/** Scrolls by `dy` over `point` as the person would at this width (positive: down). */
export async function scrollOver(
  page: Page,
  point: { x: number; y: number },
  dy: number,
): Promise<void> {
  // WebKit has no touch gestures to drive (no CDP): it scrolls with the wheel at any width.
  const webkit = page.context().browser()?.browserType().name() === 'webkit';
  if (desktop(page) || webkit) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, dy);
    return;
  }
  // A finger dragged over the text (Chromium's compositor gesture, as a real touch).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: point.x,
    y: point.y,
    yDistance: -dy,
    gestureSourceType: 'touch',
  });
  await cdp.detach();
}

/**
 * Scrolls down over `region` and expects the text to move up; text that opened already at
 * its end (a document scrolled to the highlighted term) must move back down instead.
 */
export async function expectScrolls(page: Page, region: Locator): Promise<void> {
  await expect(region).toBeVisible();
  const point = await middleOf(page, region);
  const { top, atEnd } = await probeAt(page, point);
  const before = await top();
  await scrollOver(page, point, atEnd ? -400 : 400);
  if (atEnd) await expect.poll(top).toBeGreaterThan(before + OVERFLOW);
  else await expect.poll(top).toBeLessThan(before - OVERFLOW);
}

/** Desktop: a click on the text, then Page Down and Space (Page Up and ⇧Space at its end). */
export async function expectKeyboardScrolls(page: Page, text: Locator): Promise<void> {
  if (!desktop(page)) return;
  await text.click();
  const point = await middleOf(page, text);
  const { top, atEnd } = await probeAt(page, point);
  const before = await top();
  await page.keyboard.press(atEnd ? 'PageUp' : 'PageDown');
  await page.keyboard.press(atEnd ? 'Shift+Space' : 'Space');
  if (atEnd) await expect.poll(top).toBeGreaterThan(before + OVERFLOW);
  else await expect.poll(top).toBeLessThan(before - OVERFLOW);
}


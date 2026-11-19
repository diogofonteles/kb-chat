import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';

// The v2 media areas' E2E (KBC-129, KBC-130): with KBC_SHOTS=<dir> each state is also
// captured, to compare with the v2 · Mídia frames at 1440 and 390.
const shots = process.env['KBC_SHOTS'];

export async function capture(
  page: Page,
  name: string,
  project: string,
): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${project}-${name}.png` });
}

/** The whole of the box is inside the viewport: no container clips it (D5). */
export async function expectInsideViewport(
  page: Page,
  box: Locator,
): Promise<void> {
  const rect = await box.boundingBox();
  const viewport = page.viewportSize();
  expect(rect, 'the box is on screen').not.toBeNull();
  if (!rect || !viewport) return;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
}

/**
 * A phone's long press on a library row (media-library-row-menu@mobile: its ⋯ has no
 * "Selecionar"): the finger stays on the row until its box is checked, then lifts — and the
 * lift opens nothing.
 */
export async function longPressToSelect(
  page: Page,
  row: Locator,
  box: Locator,
): Promise<void> {
  const target = row.locator('.main');
  await target.scrollIntoViewIfNeeded();
  const rect = await target.boundingBox();
  expect(rect, 'the row is on screen').not.toBeNull();
  if (!rect) return;
  const url = page.url();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await expect(box).toBeChecked();
  await page.mouse.up();
  expect(page.url(), 'the long press opened nothing').toBe(url);
}

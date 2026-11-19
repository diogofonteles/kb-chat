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

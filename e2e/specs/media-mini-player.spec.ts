import type { Page } from '@playwright/test';
import { CSRF, expect, ownerApi } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  uploadReady,
  type UploadedMedia,
} from './media-helpers.js';

let lecture: UploadedMedia;

test.beforeAll(async () => {
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Palestra no mini-player ${Date.now().toString(36)}`,
    seconds: 120,
  });
  await owner.dispose();
});

/** Opens the media, plays it and waits for the clock to move. */
async function playLecture(page: Page) {
  await page.goto(`/midia/${lecture.id}`);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
}

/** Samples the element's clock every 50 ms in the page, until `stop()`. */
async function sampleClock(page: Page) {
  await page.evaluate(() => {
    const element = document.querySelector<HTMLMediaElement>(
      '[data-media-engine]',
    );
    const samples: { at: number; time: number }[] = [];
    const timer = setInterval(
      () =>
        samples.push({
          at: performance.now(),
          time: element?.currentTime ?? -1,
        }),
      50,
    );
    Object.assign(window, { clockSamples: samples, clockTimer: timer });
  });
  return () =>
    page.evaluate(() => {
      const state = window as unknown as {
        clockSamples: { at: number; time: number }[];
        clockTimer: number;
      };
      clearInterval(state.clockTimer);
      return state.clockSamples;
    });
}

const mini = (page: Page) => page.getByRole('region', { name: 'Mini-player' });

/** To the conversation without reloading the page (phones open the Menu first). */
async function toConversation(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: /Nova conversa/ }).click();
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
}

/** A search in "Buscar documentos", with results on screen. */
async function search(page: Page, question: string) {
  const box = page.getByLabel('Sua pergunta');
  await box.fill(question);
  await box.press('Enter');
  await expect(page.getByText(/documentos · Tudo ·/)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
});

test('AC-10, NFR-1: the audio goes on while the person searches, in the mini-player', async ({
  page,
}) => {
  await playLecture(page);
  const stop = await sampleClock(page);
  await page.getByRole('link', { name: '← Mídia' }).click();
  await toConversation(page);
  await search(page, 'ritmo');
  const samples = await stop();
  // Never back, never stopped for more than 250 ms while the routes changed.
  let stillSince = samples[0]?.at ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (!previous || !current) continue;
    expect(current.time).toBeGreaterThanOrEqual(previous.time);
    if (current.time > previous.time) stillSince = current.at;
    expect(current.at - stillSince).toBeLessThan(250);
  }
  await expect(mini(page)).toBeVisible();
  await expect(
    mini(page).getByRole('link', { name: lecture.title }),
  ).toBeVisible();
  const before = (await audioState(page)).currentTime;
  await mini(page).getByRole('link', { name: lecture.title }).click();
  await expect(
    page.getByRole('heading', { name: lecture.title }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  expect((await audioState(page)).currentTime).toBeGreaterThanOrEqual(before);
  await expect(mini(page)).toHaveCount(0);
});

test('AC-7: typing in the question box never drives the mini-player', async ({
  page,
}) => {
  await playLecture(page);
  await page.getByRole('link', { name: '← Mídia' }).click();
  await toConversation(page);
  const question = page.getByLabel('Sua pergunta');
  await question.click();
  await page.keyboard.type('k l');
  await expect(question).toHaveValue('k l');
  expect((await audioState(page)).paused).toBe(false);
});

test('AC-11: "Fechar o player" stops, saves the position and closes', async ({
  page,
}) => {
  await playLecture(page);
  await page.getByRole('link', { name: '← Mídia' }).click();
  await expect(mini(page)).toBeVisible();
  const saved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && request.url().endsWith('/progress'),
  );
  await mini(page).getByRole('button', { name: 'Fechar o player' }).click();
  const body = (await saved).postDataJSON() as { positionMs: number };
  expect(body.positionMs).toBeGreaterThan(0);
  await expect(mini(page)).toHaveCount(0);
  expect(
    await page.locator('[data-media-engine]').getAttribute('src'),
  ).toBeNull();
});

test('FR-8: leaving the player paused closes it, with no mini-player', async ({
  page,
}) => {
  await page.goto(`/midia/${lecture.id}`);
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
  await page.getByRole('link', { name: '← Mídia' }).click();
  await expect(page.getByRole('heading', { name: /Mídia — / })).toBeVisible();
  await expect(mini(page)).toHaveCount(0);
});

test('AC-16: nothing focused hides behind the mini-player', async ({
  page,
}) => {
  await playLecture(page);
  await page.getByRole('link', { name: '← Mídia' }).click();
  await toConversation(page);
  await search(page, 'ritmo');
  const bar = await mini(page).boundingBox();
  expect(bar).not.toBeNull();
  await page.locator('h1').first().click();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const rect = element.getBoundingClientRect();
      return {
        what: `${element.tagName} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40)}`,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        inMini: element.closest('app-mini-player') !== null,
        hidden: rect.width === 0 && rect.height === 0,
      };
    });
    if (!focused || focused.inMini || focused.hidden) continue;
    // Never under the mini-player: the two rectangles do not meet.
    const box = bar ?? { x: 0, y: 0, width: 0, height: 0 };
    const overlaps =
      focused.bottom > box.y + 1 &&
      focused.top < box.y + box.height - 1 &&
      focused.right > box.x + 1 &&
      focused.left < box.x + box.width - 1;
    expect(
      overlaps,
      `${focused.what} (${focused.left},${focused.top})–(${focused.right},${focused.bottom})`,
    ).toBe(false);
  }
});

test('AC-16: on the media list too, nothing focused hides behind the mini-player', async ({
  page,
}) => {
  await playLecture(page);
  await page.getByRole('link', { name: '← Mídia' }).click();
  await expect(page.getByRole('heading', { name: /Mídia — / })).toBeVisible();
  const bar = await mini(page).boundingBox();
  await page.getByRole('heading', { name: /Mídia — / }).click();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const rect = element.getBoundingClientRect();
      return {
        what: element.textContent?.trim().slice(0, 40) ?? element.tagName,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        inMini: element.closest('app-mini-player') !== null,
      };
    });
    if (!focused || focused.inMini) continue;
    const box = bar ?? { x: 0, y: 0, width: 0, height: 0 };
    const overlaps =
      focused.bottom > box.y + 1 &&
      focused.top < box.y + box.height - 1 &&
      focused.right > box.x + 1 &&
      focused.left < box.x + box.width - 1;
    expect(overlaps, focused.what).toBe(false);
  }
});

test('a media removed while it plays in the mini-player stops and says why', async ({
  page,
}) => {
  const owner = await ownerApi();
  const doomed = await uploadReady(owner, {
    title: `Removida ${Date.now().toString(36)}`,
    seconds: 60,
  });
  await page.goto(`/midia/${doomed.id}`);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
  await page.getByRole('link', { name: '← Mídia' }).click();
  await expect(mini(page)).toBeVisible();
  expect(
    (
      await owner.delete(`/api/v1/media/${doomed.id}`, { headers: CSRF })
    ).status(),
  ).toBe(204);
  await owner.dispose();
  // Its next save meets a 404: the bar stops and says it.
  await mini(page).getByRole('button', { name: 'Pausar' }).click();
  await expect(mini(page).getByRole('alert')).toContainText(
    'Esta mídia não está mais no acervo',
  );
  expect((await audioState(page)).paused).toBe(true);
});

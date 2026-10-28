import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import {
  audioState,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

let lecture: UploadedMedia;
let short: UploadedMedia;

test.beforeAll(async () => {
  const owner = await ownerApi();
  const tag = Date.now().toString(36);
  // 2 minutes: to seek and to drop the connection mid-way; 6 s: to reach the end.
  lecture = await uploadReady(owner, {
    title: `Aula longa ${tag}`,
    seconds: 120,
  });
  short = await uploadReady(owner, { title: `Aula curta ${tag}`, seconds: 6 });
});

async function openPlayer(page: Page, media: UploadedMedia) {
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
}

const play = (page: Page) =>
  page.getByRole('button', { name: 'Tocar' }).click();

test('AC-1/AC-10: it never plays by itself, and really plays on "Tocar"', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  expect((await audioState(page)).paused).toBe(true);
  await play(page);
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  // Sound, not only a button: the media element's clock moves.
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
});

test('AC-2: seeking ahead plays from there, with byte ranges from the server', async ({
  page,
  browserName,
}) => {
  await openPlayer(page, lecture);
  // Playwright observes Chromium's media requests; WebKit loads media out of its sight, so
  // there the server's own answer to a range request is checked instead.
  const ranged =
    browserName === 'chromium'
      ? page.waitForResponse(
          (response) =>
            response.url().includes(`/media/${lecture.id}/stream`) &&
            response.status() === 206,
        )
      : page.request.get(`/api/v1/media/${lecture.id}/stream`, {
          headers: { range: 'bytes=1000-1999' },
        });
  await play(page);
  const response = await ranged;
  expect(response.status()).toBe(206);
  expect(response.headers()['content-range']).toMatch(/^bytes \d+-\d+\/\d+$/);
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('PageUp');
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(60);
  expect((await audioState(page)).currentTime).toBeLessThan(70);
  await expect(page.locator('.elapsed')).toHaveText(/^1:0\d$/);
});

test('AC-11: the slider speaks the time and moves 5 s per arrow, End to the end', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    '0 segundos de 2 minutos',
  );
  for (let i = 0; i < 3; i++) await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '15');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^15 segundos de 2 minutos$/,
  );
  await slider.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
});

test('AC-10: forward 30 s ends a short audio, "Ouvir de novo" plays from the start, back 15 s stops at 0', async ({
  page,
}) => {
  await openPlayer(page, short);
  await play(page);
  await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
  await expect(
    page.getByRole('button', { name: 'Ouvir de novo' }),
  ).toBeVisible();
  // At the end and stopped (Safari may not flag `ended` after a seek to the very end).
  const atEnd = await audioState(page);
  expect(atEnd.paused).toBe(true);
  expect(atEnd.currentTime).toBeGreaterThan(5.5);
  await page.getByRole('button', { name: 'Ouvir de novo' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeLessThan(3);
  await page.getByRole('button', { name: 'Pausar' }).click();
  await page.getByRole('button', { name: 'Voltar 15 segundos' }).click();
  // Back at the start (Safari pauses asynchronously and may run a few ms after the seek).
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeLessThan(0.25);
});

/**
 * Chromium's dropped connection (AC-12): the server hands over only the first 48 KB (about
 * 6 s) and later ranges fail. WebKit cannot play intercepted media, so it goes offline.
 */
async function dropConnection(page: Page): Promise<() => Promise<void>> {
  const stream = `**/media/${lecture.id}/stream`;
  const limit = 49_151;
  await page.route(stream, async (route) => {
    const range = route.request().headers()['range'] ?? '';
    const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    if (start > limit) return route.abort('internetdisconnected');
    const head = await route.fetch({
      headers: {
        ...route.request().headers(),
        range: `bytes=${start}-${limit}`,
      },
    });
    return route.fulfill({ response: head });
  });
  return async () => page.unroute(stream);
}

test('AC-12: when the network drops mid-playback, the player says so and resumes from the same second', async ({
  page,
  browserName,
}) => {
  // Playwright cannot drop WebKit's media connection mid-playback: intercepted media does
  // not play there, and on localhost the file is fully downloaded before going offline.
  // The engine's network handling is unit tested; Safari is checked on a real iPhone.
  test.skip(
    browserName === 'webkit',
    'no way to drop a WebKit media connection mid-playback',
  );
  const restore = await dropConnection(page);
  await openPlayer(page, lecture);
  await play(page);
  await expect(page.getByRole('alert')).toContainText(
    'Não consegui carregar o áudio. Verifique a conexão.',
    { timeout: 30_000 },
  );
  const stoppedAt = Number(
    await page
      .getByRole('slider', { name: 'Posição' })
      .getAttribute('aria-valuenow'),
  );
  expect(stoppedAt).toBeGreaterThan(0);
  await restore();
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(stoppedAt);
  expect((await audioState(page)).currentTime).toBeLessThan(stoppedAt + 3);
});

test('AC-14: the same stream plays, seeks and ends in a real <video> element too', async ({
  page,
}) => {
  await openPlayer(page, short);
  const result = await page.evaluate(async (src) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = src;
    document.body.append(video);
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const playedTo = video.currentTime;
    video.currentTime = 5;
    await new Promise((resolve) =>
      video.addEventListener('ended', resolve, { once: true }),
    );
    const outcome = { playedTo, ended: video.ended, duration: video.duration };
    video.remove();
    return outcome;
  }, `/api/v1/media/${short.id}/stream`);
  expect(result.playedTo).toBeGreaterThan(0.2);
  expect(result.ended).toBe(true);
  expect(result.duration).toBeGreaterThan(5.5);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-9: the player passes axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    await openPlayer(page, lecture);
    const violations = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
  });
}

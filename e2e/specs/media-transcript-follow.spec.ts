import type { Locator, Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady, type UploadedMedia } from './media-helpers.js';
import { approve, seedDraft } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

/*
 * KBC-162: the transcript follows what is heard on the player page while the page itself
 * scrolls (the owner's report: the player at 7:09, the list still on 4:41–6:52). A recording
 * of 12 min with a line every 10 s and 10 applied tracks, as the owner's; played from 4:41
 * past the lines in view for over a minute (at 4×, so a minute of speech takes 15 s). In
 * Chrome at 1440 (a window short enough for the page to scroll, as the owner's) and 390, and
 * with KBC_E2E_WEBKIT=1 in WebKit at both.
 */

let media: UploadedMedia;

// One worker per project: the recording is made once in `beforeAll`.
test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const owner = await ownerApi();
  media = await uploadReady(owner, {
    title: `Aula que segue ${uniqueTag()}`,
    seconds: 720,
    bitrate: '32k',
  });
  await seedTranscript(owner, {
    id: media.id,
    raw: rawOf(
      Array.from({ length: 72 }, (_, i) => ({
        at: i * 10,
        text: `Linha ${i} da aula, dita aos ${i * 10} segundos.`,
      })),
    ),
  });
  await seedDraft(
    owner,
    media.id,
    Array.from({ length: 10 }, (_, i) => ({
      startMs: i * 72_000,
      endMs: (i + 1) * 72_000,
      title: `Faixa ${i + 1}`,
    })),
  );
  await approve(owner, media.id);
  await owner.dispose();
});

const WIDTHS = [
  // 700 high: the main panel scrolls, the list inside it scrolls on its own.
  { width: 1440, height: 700, project: 'media-desktop' },
  { width: 390, height: 844, project: 'media-mobile' },
] as const;

const segmentsList = (page: Page) =>
  page.getByRole('list', { name: 'Trechos da transcrição' });

/** The line marked as heard now: its time button carries aria-current. */
const heard = (page: Page) =>
  segmentsList(page).locator('li.active:has([aria-current="true"])');

/** The skip forward, by the person's own step (the owner's may not be 30 s). */
const FORWARD = /^Avançar \d+ segundos$/;

const backToCurrent = (page: Page) =>
  page.getByRole('button', { name: 'Voltar ao trecho atual' });

const mediaTime = (page: Page) =>
  page
    .locator('[data-media-engine]')
    .evaluate((element) => (element as HTMLMediaElement).currentTime);

/** The page's own scroller around the list (the main panel), and how far it can go. */
const pageScroll = (list: Locator) =>
  list.evaluate((element) => {
    let at = element.parentElement;
    while (at) {
      const { overflowY } = getComputedStyle(at);
      if (/(auto|scroll)/.test(overflowY) && at.scrollHeight > at.clientHeight)
        return { top: at.scrollTop, max: at.scrollHeight - at.clientHeight };
      at = at.parentElement;
    }
    const root = document.scrollingElement ?? document.documentElement;
    return { top: root.scrollTop, max: root.scrollHeight - root.clientHeight };
  });

/**
 * The heard line is the list's only marked one and the person sees it: inside the list's
 * box, and what the screen shows at its middle (no scroller cuts it off, nothing covers it).
 */
const heardOnScreen = (page: Page) =>
  segmentsList(page).evaluate((list) => {
    const lines = list.querySelectorAll('li.active');
    const line = list.querySelector('li.active:has([aria-current="true"])');
    if (lines.length !== 1 || !line) return false;
    const box = list.getBoundingClientRect();
    const own = line.getBoundingClientRect();
    const middle = document.elementFromPoint(
      own.left + own.width / 2,
      own.top + own.height / 2,
    );
    return (
      own.top >= box.top - 1 &&
      own.bottom <= box.bottom + 1 &&
      middle !== null &&
      line.contains(middle)
    );
  });

/** Seeks the engine's element once it has its metadata and no seek in flight. */
async function seekTo(page: Page, seconds: number): Promise<void> {
  const engine = page.locator('[data-media-engine]');
  await expect
    .poll(() =>
      engine.evaluate((element) => {
        const audio = element as HTMLMediaElement;
        return audio.readyState >= audio.HAVE_METADATA && !audio.seeking;
      }),
    )
    .toBe(true);
  await engine.evaluate((element, at) => {
    (element as HTMLMediaElement).currentTime = at;
  }, seconds);
}

/** Waits until the list's own smooth scroll has landed: two reads 250 ms apart agree. */
async function settled(list: Locator): Promise<void> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await list.evaluate((element) => element.scrollTop);
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [250] },
    )
    .toBe(true);
}

/** Opens the recording, plays it from 4:41 and waits for the line of 4:40 to be marked. */
async function playFrom441(page: Page): Promise<Locator> {
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  const list = segmentsList(page);
  await expect(list.getByText('Linha 28 da aula')).toBeAttached();
  await seekTo(page, 281);
  await page
    .getByRole('button', { name: /^Tocar/ })
    .first()
    .click();
  await expect(heard(page)).toContainText('Linha 28 da aula');
  await expect.poll(() => heardOnScreen(page)).toBe(true);
  await settled(list);
  return list;
}

/** Counts the wheel events that land on the list (their target is one of its lines). */
const countWheelsOnList = (list: Locator) =>
  list.evaluate((element) => {
    const seen = window as unknown as { listWheels: number };
    seen.listWheels = 0;
    element.addEventListener('wheel', () => (seen.listWheels += 1), {
      capture: true,
      passive: true,
    });
  });

const wheelsOnList = (page: Page) =>
  page.evaluate(() => (window as unknown as { listWheels: number }).listWheels);

/**
 * The person scrolls the page down with the wheel, from just above the list: the page moves
 * the list under the pointer, so the wheel lands on its lines while it is the page that
 * scrolls. Stops once a wheel landed on the list (more would scroll the list itself).
 */
async function scrollThePageOverTheList(
  page: Page,
  list: Locator,
): Promise<boolean> {
  const box = await list.boundingBox();
  if (!box) throw new Error('the list has no box');
  await page.mouse.move(box.x + box.width / 2, Math.max(4, box.y - 24));
  const before = await pageScroll(list);
  expect(before.max, 'the page scrolls at this size').toBeGreaterThan(0);
  const listAt = await list.evaluate((element) => element.scrollTop);
  for (let step = 0; step < 10 && (await wheelsOnList(page)) === 0; step++) {
    await page.mouse.wheel(0, 100);
    // The event reaches the page after the call returns: count it before the next one.
    await page.waitForTimeout(100);
  }
  expect(
    await wheelsOnList(page),
    'a wheel landed on the list',
  ).toBeGreaterThan(0);
  await expect
    .poll(async () => (await pageScroll(list)).top, {
      message: 'the page scrolled',
    })
    .toBeGreaterThan(before.top);
  // Chromium and Safari keep the wheel on the page that started scrolling; Linux WebKit hands
  // it to the list under the pointer. Says which one moved, for the caller to expect its rule.
  return (await list.evaluate((element) => element.scrollTop)) === listAt;
}

for (const size of WIDTHS) {
  test.describe(`${size.width} px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(() => {
      const project = test.info().project.name;
      test.skip(
        project !== size.project && project !== 'media-webkit',
        `${size.width} px runs in ${size.project} and media-webkit`,
      );
    });

    test('the line heard stays marked and in view for over a minute, while the page scrolls over the list', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const list = await playFrom441(page);
      await countWheelsOnList(list);
      const onlyThePage = await scrollThePageOverTheList(page, list);
      if (onlyThePage) {
        // Scrolling the page is not scrolling the list: it keeps following.
        await expect(backToCurrent(page)).toHaveCount(0);
      } else {
        // This browser scrolled the list itself: the person's scroll stops following (FR-3),
        // and a skip in the player brings it back before the minute below.
        await expect(backToCurrent(page)).toBeVisible();
        await page.getByRole('button', { name: FORWARD }).first().click();
        await expect(backToCurrent(page)).toHaveCount(0);
      }
      const pageAt = (await pageScroll(list)).top;

      // A minute and more of speech at 4× (the engine leaves the element's rate alone).
      await page
        .locator('[data-media-engine]')
        .evaluate(
          (element) => ((element as HTMLMediaElement).playbackRate = 4),
        );
      const from = await mediaTime(page);
      const lines = new Set<string>();
      while ((await mediaTime(page)) < from + 65) {
        await expect.poll(() => heardOnScreen(page)).toBe(true);
        lines.add((await heard(page).getAttribute('data-index')) ?? '');
        await expect(backToCurrent(page)).toHaveCount(0);
        await page.waitForTimeout(500);
      }
      // Past the lines that were in view: six lines of 10 s heard, each marked in its turn.
      expect(lines.size).toBeGreaterThanOrEqual(6);
      await expect(heard(page)).toContainText(/Linha 3[4-9] da aula/);
      // Only the list moved: the page stayed where the person left it.
      expect((await pageScroll(list)).top).toBe(pageAt);
    });

    test('FR-8: scrolling the list by hand or typing a search stops following; a skip in the player or the mini-player resumes it', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const list = await playFrom441(page);
      // The page to its end first, from outside the list, then the wheel over the list.
      await page.mouse.move(size.width / 2, 120);
      for (let step = 0; step < 6; step++) await page.mouse.wheel(0, 200);
      await list.hover();
      const listAt = await list.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, -400);
      await expect(backToCurrent(page)).toBeVisible();
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBeLessThan(listAt);
      // Stopped: the list stays where the person left it while the next line is marked.
      // The audio must really be moving first (a cold first run may still be loading it), and
      // at 4× the next 10 s line comes in under 3 s instead of up to 10.
      await page
        .locator('[data-media-engine]')
        .evaluate(
          (element) => ((element as HTMLMediaElement).playbackRate = 4),
        );
      const playingAt = await mediaTime(page);
      await expect.poll(() => mediaTime(page)).toBeGreaterThan(playingAt + 1);
      const left = await list.evaluate((element) => element.scrollTop);
      const before = (await heard(page).getAttribute('data-index')) ?? '';
      await expect
        .poll(
          async () => (await heard(page).getAttribute('data-index')) ?? '',
          {
            timeout: 15_000,
          },
        )
        .not.toBe(before);
      expect(await list.evaluate((element) => element.scrollTop)).toBe(left);

      // A skip in the page's player brings it back to what is heard.
      await page.getByRole('button', { name: FORWARD }).first().click();
      await expect(backToCurrent(page)).toHaveCount(0);
      await expect.poll(() => heardOnScreen(page)).toBe(true);

      // At 1440 the app's bar is an inert echo of this page's player: away from the page it
      // is the mini-player, and its skip moves the audio; back on the page, the list follows.
      if (size.width >= 1024) {
        await page.getByRole('button', { name: 'Início' }).click();
        await expect(segmentsList(page)).toHaveCount(0);
        const mini = page.getByRole('region', { name: 'Mini-player' });
        await expect(mini).toBeVisible();
        const left = await mediaTime(page);
        await mini.getByRole('button', { name: FORWARD }).click();
        await expect.poll(() => mediaTime(page)).toBeGreaterThan(left + 20);
        await page.getByRole('button', { name: 'Voltar', exact: true }).click();
        await expect(heard(page)).toBeVisible();
        await expect(backToCurrent(page)).toHaveCount(0);
        await expect.poll(() => heardOnScreen(page)).toBe(true);
      }

      // The keys on the list itself scroll it and stop following too (QA BUG-1).
      await list.evaluate((element) => {
        element.setAttribute('tabindex', '-1');
        element.focus();
      });
      await page.keyboard.press('PageDown');
      await expect(backToCurrent(page)).toBeVisible();
      await list.evaluate((element) => element.removeAttribute('tabindex'));
      await page.getByRole('button', { name: FORWARD }).first().click();
      await expect(backToCurrent(page)).toHaveCount(0);

      // Typing a search stops it too, until the field is cleared.
      const field = page.getByLabel('Buscar na transcrição');
      if (!(await field.isVisible()))
        await page
          .getByRole('button', { name: 'Mostrar a busca na transcrição' })
          .click();
      await field.fill('aula');
      await expect(backToCurrent(page)).toBeVisible();
      await field.press('Escape');
      await expect(backToCurrent(page)).toHaveCount(0);
      await expect.poll(() => heardOnScreen(page)).toBe(true);
    });
  });
}

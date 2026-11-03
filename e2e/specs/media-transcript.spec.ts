import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, invite, ownerApi, pageAs, uniqueEmail } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';
import {
  rawOf,
  seedTranscript,
  type SpokenLine,
} from './transcript-helpers.js';

// KBC-038: subtitles and the clickable transcript beside the player.

/** 0–30 s: a line every 2 s ("Salomão" three times); then one every 30 s; minute 20: every 3 s. */
function lectureLines(): SpokenLine[] {
  const opening = Array.from({ length: 15 }, (_, i) => ({
    at: i * 2,
    text: `Frase número ${i} da abertura.`,
  }));
  opening[6] = { at: 12, text: 'O rei Salomão falou.' };
  opening[7] = { at: 14, text: 'Salomao era sábio.' };
  opening[8] = { at: 16, text: 'E SALOMÃO voltou.' };
  const middle = Array.from({ length: 39 }, (_, i) => ({
    at: 30 + i * 30,
    text: `Trecho ${i + 1} sobre o tema ${i + 1}.`,
  }));
  const twelve = { at: 754, text: 'No minuto doze, o vegetal aparece.' };
  // Dense speech with wide letters: a full two-line subtitle (BUG-1).
  const dense = { at: 40, text: DENSE_LINE };
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    at: 1_200 + i * 3,
    text:
      i === 0
        ? 'No minuto vinte, a frase marcada.'
        : `Minuto vinte, frase ${i}.`,
  }));
  return [...opening, ...middle, twelve, dense, ...twenty].sort(
    (a, b) => a.at - b.at,
  );
}

/** 84 characters (42 + 41), no sentence end or pause inside: one cue of two full lines. */
const DENSE_LINE =
  'Coração ação canção questão emoção relação paixão nação razão sertão MMMWWW aqui ali';

let lecture: UploadedMedia;
let other: UploadedMedia;
let noisy: UploadedMedia;

test.beforeAll(async () => {
  // Three conversions; a loaded machine makes them slow (each waits up to 2 min).
  test.setTimeout(600_000);
  const owner = await ownerApi();
  const tag = uniqueTag();
  lecture = await uploadReady(owner, {
    title: `Palestra transcrita ${tag}`,
    seconds: 1_260,
    bitrate: '32k',
    readyWithinMs: 120_000,
  });
  other = await uploadReady(owner, {
    title: `Outra transcrita ${tag}`,
    seconds: 20,
  });
  noisy = await uploadReady(owner, {
    title: `Gravação ruidosa ${tag}`,
    seconds: 12,
  });
  await seedTranscript(owner, { id: lecture.id, raw: rawOf(lectureLines()) });
  await seedTranscript(owner, {
    id: other.id,
    raw: rawOf([
      { at: 0, text: 'Outra mídia, primeira frase.' },
      { at: 5, text: 'Segunda frase da outra mídia.' },
    ]),
  });
  await seedTranscript(owner, {
    id: noisy.id,
    raw: rawOf(
      [
        { at: 0, text: 'Trecho que talvez esteja errado.' },
        { at: 5, text: 'Outro trecho incerto.' },
      ],
      { low: true },
    ),
  });
  await owner.dispose();
});

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openPlayer(page: Page, media: UploadedMedia, query = '') {
  await page.goto(`/midia/${media.id}${query}`);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Transcrição', level: 3 }),
  ).toBeVisible();
}

const segmentsList = (page: Page) =>
  page.getByRole('list', { name: 'Trechos da transcrição' });

/** The segment marked as heard now (its time button has aria-current). */
const activeSegment = (page: Page) =>
  segmentsList(page).locator('li:has([aria-current="true"])');

const backToCurrent = (page: Page) =>
  page.getByRole('button', { name: 'Voltar ao trecho atual' });

const captionsButton = (page: Page) =>
  page.getByRole('button', { name: 'Legendas' });

/** Starting playback from a segment: its text clicked. */
async function playFromText(page: Page, text: string) {
  await segmentsList(page).getByText(text).click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
}

const seriousViolations = async (page: Page) =>
  (
    await new AxeBuilder({ page }).include('app-media-player-page').analyze()
  ).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

/** The list's scroll position once it stops moving (smooth scrolling ends). */
async function settledScrollTop(list: Locator): Promise<number> {
  return list.evaluate(async (element) => {
    let last = -1;
    for (let still = 0; still < 10;) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      still = element.scrollTop === last ? still + 1 : 0;
      last = element.scrollTop;
    }
    return last;
  });
}

/** Whether `inner` is fully inside `outer` on screen. */
async function inside(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!a || !b) return false;
  return a.y >= b.y - 1 && a.y + a.height <= b.y + b.height + 1;
}

test('AC-1, AC-4: subtitles follow the audio within 84 characters, stay on for another media, and C turns them off', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const cc = captionsButton(page);
  await expect(cc).toHaveAttribute('aria-pressed', 'false');
  await cc.click();
  await expect(cc).toHaveAttribute('aria-pressed', 'true');
  await playFromText(page, 'O rei Salomão falou.');
  const caption = page.locator('app-media-player .caption');
  await expect(caption).toContainText('Salomão');
  await expect
    .poll(async () => (await caption.textContent())?.trim() ?? '')
    .toMatch(/Salomao era sábio\.|E SALOMÃO voltou\./);
  for (const text of await caption.allTextContents())
    expect(text.replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual(84);
  await page.getByRole('button', { name: 'Pausar' }).click();

  await openPlayer(page, other);
  await expect(captionsButton(page)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('body').press('c');
  await expect(captionsButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('app-media-player .caption-area')).toHaveCount(0);
});

test('AC-1: a full two-line subtitle is never clipped, at 390 px either', async ({
  page,
}, testInfo) => {
  await openPlayer(page, lecture);
  await captionsButton(page).click();
  const line = segmentsList(page).getByText(DENSE_LINE);
  await line.scrollIntoViewIfNeeded();
  await playFromText(page, DENSE_LINE);
  const caption = page.locator('app-media-player .caption');
  await expect(caption).toContainText('Coração');
  await page.getByRole('button', { name: 'Pausar' }).click();
  const shown = await caption.evaluate((element) => ({
    // Lines on screen: the text's height over one line's height.
    screenLines: Math.round(
      (element.clientHeight -
        parseFloat(getComputedStyle(element).paddingTop) -
        parseFloat(getComputedStyle(element).paddingBottom)) /
        parseFloat(getComputedStyle(element).lineHeight),
    ),
    text: element.textContent ?? '',
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    lines: (element.textContent ?? '').split('\n'),
  }));
  // Nothing hidden: the whole cue is in the box, two lines of at most 42 characters.
  expect(shown.scrollHeight).toBeLessThanOrEqual(shown.clientHeight);
  expect(shown.lines).toHaveLength(2);
  expect(shown.screenLines).toBeLessThanOrEqual(2);
  for (const text of shown.lines) expect(text.length).toBeLessThanOrEqual(42);
  expect(shown.text.replace('\n', ' ')).toBe(DENSE_LINE);
  await saveEvidence(page, `${testInfo.project.name}-two-line-caption`);
});

test('AC-2, AC-3: a phrase of minute 20 plays when clicked; scrolling stops the following until "Voltar ao trecho atual"', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const list = segmentsList(page);
  await list
    .getByText('No minuto vinte, a frase marcada.')
    .scrollIntoViewIfNeeded();
  await playFromText(page, 'No minuto vinte, a frase marcada.');
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(1_200);
  expect((await audioState(page)).currentTime).toBeLessThan(1_204);
  await expect(activeSegment(page)).toContainText(
    'No minuto vinte, a frase marcada.',
  );
  await expect(backToCurrent(page)).toHaveCount(0);

  // The person scrolls up with the wheel: the list stops following.
  const following = await settledScrollTop(list);
  await list.hover();
  await page.mouse.wheel(0, -1_500);
  await expect(backToCurrent(page)).toBeVisible();
  // The wheel scrolls smoothly: wait until it settles, then remember where it stopped.
  const scrolled = await settledScrollTop(list);
  const before = (await activeSegment(page).textContent()) ?? '';
  // The audio moves to the next segments (every 3 s) and the list stays where it was.
  await expect
    .poll(async () => (await activeSegment(page).textContent()) ?? '', {
      timeout: 10_000,
    })
    .not.toBe(before);
  expect(await settledScrollTop(list)).toBe(scrolled);
  // The wheel did move the list up, and it stayed there.
  expect(scrolled).toBeLessThan(following);

  await backToCurrent(page).click();
  await expect(backToCurrent(page)).toHaveCount(0);
  await expect.poll(() => inside(activeSegment(page), list)).toBe(true);
  await expect(activeSegment(page).getByRole('button')).toBeFocused();
});

test('AC-3: moving through the list with the keyboard also stops the following', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await playFromText(page, 'Frase número 3 da abertura.');
  await activeSegment(page).getByRole('button').focus();
  await page.keyboard.press('ArrowUp');
  await expect(backToCurrent(page)).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(backToCurrent(page)).toBeVisible();
});

test('AC-8, AC-7: one Tab stop; ↓ twice and Enter plays the third segment; Tab leaves the list', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await page.getByLabel('Buscar na transcrição').focus();
  await page.keyboard.press('Tab');
  const first = segmentsList(page).getByRole('button', {
    name: 'Tocar de 0 segundos',
  });
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const third = segmentsList(page).getByRole('button', {
    name: 'Tocar de 4 segundos',
  });
  await expect(third).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(4);
  await expect(activeSegment(page)).toContainText(
    'Frase número 2 da abertura.',
  );
  await page.keyboard.press('Tab');
  const focusedInList = await segmentsList(page).evaluate((list) =>
    list.contains(document.activeElement),
  );
  expect(focusedInList).toBe(false);
  // Only one segment is reachable with Tab.
  expect(await segmentsList(page).locator('button[tabindex="0"]').count()).toBe(
    1,
  );
});

test('AC-9: "salomao" finds Salomão three times, Enter goes to the 2nd and "Tocar daqui" plays it; "xyz" finds nothing', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const field = page.getByLabel('Buscar na transcrição');
  await field.fill('salomao');
  const status = page.locator('app-transcript-panel [role="status"]');
  await expect(status).toHaveText('1 de 3');
  await expect(segmentsList(page).locator('mark')).toHaveCount(3);
  await field.press('Enter');
  await expect(status).toHaveText('2 de 3');
  await expect(segmentsList(page).locator('mark.current')).toHaveText(
    'Salomao',
  );
  await page.getByRole('button', { name: 'Tocar daqui' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(14);
  expect((await audioState(page)).currentTime).toBeLessThan(16);
  await field.fill('xyz');
  await expect(status).toHaveText("Nenhum trecho com 'xyz'.");
});

test('AC-10: a selection is copied in quotes with the title and the link to its minute; a hidden transcript stays hidden', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright grants clipboard access only in Chromium',
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPlayer(page, lecture);
  const text = segmentsList(page).getByText(
    'No minuto doze, o vegetal aparece.',
  );
  await text.scrollIntoViewIfNeeded();
  await text.evaluate((element) => {
    const node = element.firstChild;
    if (!node) throw new Error('no text');
    const range = document.createRange();
    range.setStart(node, 16);
    range.setEnd(node, 25);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  await page
    .getByRole('button', { name: 'Copiar com o link do minuto' })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(
      `“o vegetal”\n${lecture.title}\n${new URL(page.url()).origin}/midia/${lecture.id}?t=754`,
    );
  expect((await audioState(page)).paused).toBe(true);

  // "Copiar link deste minuto" in "Mais opções": the second heard now.
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page
    .getByRole('menuitem', { name: 'Copiar link deste minuto' })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(new RegExp(`/midia/${lecture.id}\\?t=0$`));

  await page.getByRole('button', { name: 'Esconder transcrição' }).click();
  await expect(segmentsList(page)).toHaveCount(0);
  await page.goto(`/midia/${other.id}`);
  await expect(page.getByRole('heading', { name: other.title })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Mostrar transcrição' }),
  ).toBeVisible();
  await expect(segmentsList(page)).toHaveCount(0);
});

test('AC-5: ?t=754 starts at 12:34; someone without access gets "not found"', async ({
  page,
  browser,
  viewport,
}) => {
  await openPlayer(page, lecture, '?t=754');
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeCloseTo(754, 0);
  expect((await audioState(page)).paused).toBe(true);
  await expect(page.locator('app-media-player .elapsed')).toHaveText('12:34');
  await expect(page.getByRole('button', { name: /Continuar de/ })).toHaveCount(
    0,
  );
  await expect(activeSegment(page)).toContainText('o vegetal');

  const email = uniqueEmail('sem-acesso-transcricao');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['alquimia'],
    features: ['search', 'media'],
  });
  await owner.dispose();
  const stranger = await pageAs(browser, email, viewport);
  await stranger.goto(`/midia/${lecture.id}?t=754`);
  await expect(
    stranger.getByText(
      'Esta mídia não está mais no acervo ou você não tem acesso a ela.',
    ),
  ).toBeVisible();
  const vtt = await stranger.request.get(
    `/api/v1/media/${lecture.id}/subtitles.vtt`,
  );
  expect(vtt.status()).toBe(404);
  await stranger.context().close();
});

test('AC-6: a low-confidence transcript says so above the text', async ({
  page,
}) => {
  await openPlayer(page, noisy);
  const notice = page
    .locator('app-transcript-panel')
    .getByText(
      'Transcrição automática de baixa confiança: pode haver trechos errados.',
    );
  await expect(notice).toBeVisible();
  const [noticeBox, listBox] = await Promise.all([
    notice.boundingBox(),
    segmentsList(page).boundingBox(),
  ]);
  expect((noticeBox?.y ?? 0) < (listBox?.y ?? 0)).toBe(true);
  // Subtitles on: a phone stacks the column far below, so a short notice goes with them.
  await captionsButton(page).click();
  const badge = page.getByText(
    'Legendas de baixa confiança: podem ter trechos errados.',
  );
  if (desktop(page)) await expect(badge).toBeHidden();
  else await expect(badge).toBeInViewport();
  await captionsButton(page).click();
  // Hidden column, subtitles on: the header keeps the notice in view (KBC-036 BR-5).
  await page.getByRole('button', { name: 'Esconder transcrição' }).click();
  await captionsButton(page).click();
  await expect(
    page.getByText(
      'Transcrição automática de baixa confiança: pode haver trechos errados.',
    ),
  ).toBeVisible();
});

test('NFR-1: the highlighted segment follows the audio within 250 ms', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await playFromText(page, 'Frase número 0 da abertura.');
  // Measured once playback runs on its own (the start of a stream is not the player's).
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(1);
  const { misses, samples } = await page.evaluate(async () => {
    const audio = document.querySelector<HTMLMediaElement>(
      '[data-media-engine]',
    );
    const starts = Array.from(
      document.querySelectorAll<HTMLElement>('li[data-start-ms]'),
    ).map((item) => Number(item.dataset['startMs']));
    const misses: number[] = [];
    let samples = 0;
    const until = performance.now() + 6_000;
    let previous = performance.now();
    while (performance.now() < until) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const frameAt = performance.now();
      // A frame after the page itself froze (a loaded machine), or with the audio waiting
      // for data, shows nothing about the highlight: those are not samples.
      const frozen = frameAt - previous > 100;
      previous = frameAt;
      if (frozen || !audio || audio.readyState < 3 || audio.paused) continue;
      samples++;
      const now = audio.currentTime * 1000;
      const shown = Number(
        document.querySelector<HTMLElement>('li:has([aria-current="true"])')
          ?.dataset['startMs'] ?? -1,
      );
      const index = starts.indexOf(shown);
      const next = starts[index + 1] ?? Number.POSITIVE_INFINITY;
      // The marked segment must contain the audio's time, give or take 250 ms.
      if (shown > now + 250 || next < now - 250) misses.push(now);
    }
    return { misses, samples };
  });
  // Frames are skipped only when they say nothing; 6 s must still give real samples
  // (about 360 at 60 fps), or the check would pass without measuring.
  expect(samples).toBeGreaterThanOrEqual(120);
  expect(misses).toEqual([]);
});

test('NFR-2: a 2 h transcript (~20 000 words) opens and answers clicks and keys with INP ≤ 200 ms', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'media-desktop',
    'Measured once, on the desktop notebook profile',
  );
  test.setTimeout(400_000);
  const owner = await ownerApi();
  const long = await uploadReady(owner, {
    title: `Palestra de 2 h ${uniqueTag()}`,
    seconds: 7_200,
    bitrate: '32k',
    readyWithinMs: 300_000,
  });
  const lines = Array.from({ length: 1_500 }, (_, i) => ({
    at: i * 4.8,
    text: `Trecho ${i} fala do assunto ${i} com palavras bastante comuns na leitura ${i}.`,
  }));
  await seedTranscript(owner, { id: long.id, raw: rawOf(lines) });
  await owner.dispose();
  // Event Timing: the longest interaction (click, key) from the page's own measurements.
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.assign(window, { kbcInteractions: durations });
    // Event Timing fields newer than this project's DOM typings.
    type EventEntry = PerformanceEntry & { readonly interactionId?: number };
    const options: PerformanceObserverInit & { durationThreshold: number } = {
      type: 'event',
      buffered: true,
      durationThreshold: 16,
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as EventEntry[])
        if (entry.interactionId) durations.push(entry.duration);
    }).observe(options);
  });
  await openPlayer(page, long);
  await expect(segmentsList(page).locator('li')).toHaveCount(1_500);
  for (const n of [3, 400, 900, 1_499]) {
    const text = segmentsList(page).getByText(`Trecho ${n} fala do assunto`);
    await text.scrollIntoViewIfNeeded();
    await text.click();
  }
  await activeSegment(page).getByRole('button').focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  await page
    .getByLabel('Buscar na transcrição')
    .pressSequentially('assunto 14');
  await page.keyboard.press('Enter');
  await expect(page.locator('app-transcript-panel [role="status"]')).toHaveText(
    // "assunto 14": 14, 140–149 and 1 400–1 499; Enter went to the 2nd.
    '2 de 111',
  );
  const durations = await page.evaluate(
    () => (window as unknown as { kbcInteractions: number[] }).kbcInteractions,
  );
  expect(durations.length).toBeGreaterThan(0);
  expect(Math.max(...durations)).toBeLessThanOrEqual(200);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-7: the player with subtitles and the transcript pass axe in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await useTheme(page, theme);
    await openPlayer(page, lecture);
    await captionsButton(page).click();
    await playFromText(page, 'O rei Salomão falou.');
    await expect(page.locator('app-media-player .caption')).toBeVisible();
    await page.getByRole('button', { name: 'Pausar' }).click();
    await page.getByLabel('Buscar na transcrição').fill('salomao');
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await seriousViolations(page)).toEqual([]);
    await saveEvidence(page, `${testInfo.project.name}-${theme}-normal`);

    await openPlayer(page, noisy);
    expect(await seriousViolations(page)).toEqual([]);
    await saveEvidence(page, `${testInfo.project.name}-${theme}-low`);
  });
}

test('the column sits beside the player on a wide screen and below it on a phone', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const [player, panel] = await Promise.all([
    page.locator('app-media-player').boundingBox(),
    page.locator('app-transcript-panel').boundingBox(),
  ]);
  if (!player || !panel) throw new Error('not laid out');
  if (desktop(page))
    expect(panel.x).toBeGreaterThan(player.x + player.width - 1);
  else expect(panel.y).toBeGreaterThan(player.y + player.height - 1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

/** Local validation (KBC-038): screenshots when KBC_EVIDENCE_DIR is set. */
async function saveEvidence(page: Page, name: string): Promise<void> {
  const dir = process.env['KBC_EVIDENCE_DIR'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
}

import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady } from './media-helpers.js';
import { seedDraft, trackRow } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

// KBC-115: choosing many words of the track text at once (a drag, a held finger, Shift+click,
// Shift+arrows), on a real transcript seeded with known word times (0.3 s apart). The panel
// opens on all of them, and "Corrigir todas" looks for the whole sequence.

const SPEECH = [
  { at: 5, text: 'abertura da sessão de hoje' },
  /** "mestre" starts at 0:12.3. */
  { at: 12, text: 'o mestre Tiuako disse assim' },
  { at: 20, text: 'e voltou depois' },
  { at: 40, text: 'o mestre Tiuako falou na segunda faixa' },
];
const TRACKS = [
  { startMs: 0, endMs: 30_000, title: 'Primeira pergunta' },
  { startMs: 30_000, endMs: 60_000, title: 'Segunda pergunta' },
];

/** Enough lines in the first track for its text block to scroll at 390 px (AC-9). */
const MANY_LINES = Array.from({ length: 14 }, (_, index) => ({
  at: 2 + index * 2,
  text: `linha ${index + 1} fala do mestre`,
}));

interface Media {
  readonly id: string;
}

/** A recording of its own per test: corrections change it (TE-18). */
async function lecture(owner: APIRequestContext): Promise<Media> {
  const media = await uploadReady(owner, {
    title: `Várias palavras ${uniqueTag()}`,
    seconds: 70,
    bitrate: '32k',
  });
  await seedTranscript(owner, { id: media.id, raw: rawOf(SPEECH) });
  await seedDraft(owner, media.id, TRACKS);
  return media;
}

/** A recording whose first track has many short lines. */
async function longLecture(owner: APIRequestContext): Promise<Media> {
  const media = await uploadReady(owner, {
    title: `Muitas linhas ${uniqueTag()}`,
    seconds: 70,
    bitrate: '32k',
  });
  await seedTranscript(owner, { id: media.id, raw: rawOf(MANY_LINES) });
  await seedDraft(owner, media.id, TRACKS);
  return media;
}

const textOf = (page: Page) =>
  page.getByRole('region', { name: 'Texto da faixa 1' });

const audition = (page: Page) =>
  page.locator('audio[hidden]:not([data-media-engine])').first();

const panel = (page: Page) =>
  page.getByRole('dialog', { name: /^Corrigir palavra/ });

const field = (page: Page) =>
  panel(page).getByRole('textbox', { name: 'Texto certo' });

async function openStep3(
  page: Page,
  media: Media,
  says = 'o mestre Tiuako disse assim',
) {
  await page.goto(`/midia/${media.id}/faixas`);
  await trackRow(page, 1).getByRole('button').first().click();
  await expect(textOf(page)).toContainText(says);
  await expect(audition(page)).toBeAttached();
}

/** Where the browser draws the `nth` "word" of the text: its middle. */
async function wordAt(
  region: Locator,
  word: string,
  { nth = 0, scroll = true }: { nth?: number; scroll?: boolean } = {},
): Promise<{ x: number; y: number }> {
  const box = await region.evaluate(
    (element, { word, nth, scroll }) => {
      const found = Array.from(element.querySelectorAll('.line'))
        .flatMap((line) => {
          const node = line.firstChild;
          const text = node?.textContent ?? '';
          const hits: { node: Node; at: number }[] = [];
          for (
            let at = text.indexOf(word);
            at >= 0;
            at = text.indexOf(word, at + 1)
          )
            if (node) hits.push({ node, at });
          return hits;
        })
        .at(nth);
      if (!found) return null;
      if (scroll) found.node.parentElement?.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(found.node, found.at);
      range.setEnd(found.node, found.at + word.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { word, nth, scroll },
  );
  if (!box) throw new Error(`no "${word}" in the text`);
  return box;
}

/** A mouse drag from one word to another, in steps as a hand moves. */
async function drag(region: Locator, from: string, to: string) {
  const page = region.page();
  const start = await wordAt(region, from);
  const end = await wordAt(region, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

/** The words painted as "being corrected" (KBC-093 NFR-5). */
const correcting = (page: Page) =>
  page.evaluate(() => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const [range] = Array.from(registry.get('correcting-word') ?? []);
    return range?.toString() ?? null;
  });

const auditionTime = (page: Page) =>
  audition(page).evaluate(
    (element) => (element as HTMLAudioElement).currentTime,
  );

async function saveEvidence(page: Page, name: string): Promise<void> {
  const dir = process.env['KBC_EVIDENCE_DIR'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page
    .locator('app-track-text')
    .first()
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test('AC-1, AC-2: a mouse drag opens the panel on the words, and Corrigir todas changes the whole sequence', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'media-mobile', 'the mouse');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  const region = textOf(page);

  await drag(region, 'mestre', 'Tiuako');

  await expect(panel(page)).toHaveAccessibleName(
    'Corrigir palavras, mestre Tiuako',
  );
  await expect(field(page)).toHaveValue('mestre Tiuako');
  await expect(field(page)).toBeFocused();
  await expect.poll(() => correcting(page)).toBe('mestre Tiuako');
  expect(await auditionTime(page)).toBeCloseTo(12.3, 0);
  await expect(
    page.getByRole('status').filter({ hasText: '2 palavras escolhidas' }),
  ).toHaveCount(1);
  await saveEvidence(page, `${testInfo.project.name}-span-panel`);

  await expect(panel(page)).toContainText(
    'Este trecho aparece 2 vezes na gravação',
  );
  await panel(page).getByRole('button', { name: 'Corrigir todas' }).click();
  const dialog = page.getByRole('dialog', { name: 'Corrigir todas' });
  await expect(dialog).toContainText('Ocorrências de «mestre Tiuako»');
  await dialog.getByRole('radio', { name: 'Na gravação inteira (2)' }).check();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await dialog
    .getByRole('textbox', { name: 'Texto certo' })
    .fill('Mestre Tiuaco');
  await saveEvidence(page, `${testInfo.project.name}-span-correct-all`);
  await dialog.getByRole('button', { name: 'Corrigir 2 ocorrências' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(region).toContainText('o Mestre Tiuaco disse assim');
  await page.getByRole('button', { name: 'Ver transcrição completa' }).click();
  await expect(region).toContainText('o Mestre Tiuaco falou na segunda faixa');
});

test('AC-3: a drag into the next line stops at the end of its own, and says why', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'media-mobile', 'the mouse');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);

  await drag(textOf(page), 'Tiuako', 'voltou');

  await expect(field(page)).toHaveValue('Tiuako disse assim');
  await expect(panel(page)).toContainText(
    'A correção fica dentro de um trecho, com até 5 palavras.',
  );
});

test('AC-6, AC-7: Shift+click stretches the open choice; Shift+→ on the text chooses by keyboard', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'media-mobile', 'the keyboard and mouse');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  const region = textOf(page);

  const mestre = await wordAt(region, 'mestre');
  await page.mouse.click(mestre.x, mestre.y);
  await expect(field(page)).toHaveValue('mestre');
  const atWord = await auditionTime(page);
  await field(page).fill('Mestre');
  const disse = await wordAt(region, 'disse');
  await page.keyboard.down('Shift');
  await page.mouse.click(disse.x, disse.y);
  await page.keyboard.up('Shift');
  await expect(panel(page)).toHaveAccessibleName(
    'Corrigir palavras, mestre Tiuako disse',
  );
  await expect(field(page)).toHaveValue('Mestre');
  expect(await auditionTime(page)).toBe(atWord);

  await panel(page).getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(region).toBeFocused();
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => correcting(page)).toBe('mestre Tiuako disse');
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.up('Shift');
  await expect(field(page)).toHaveValue('mestre Tiuako disse');
  await expect(field(page)).toBeFocused();
});

test('AC-9: on a touch screen, a held finger dragged over words chooses them, and the block does not scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'media-mobile', 'the touch screen');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  const region = textOf(page);
  await region.evaluate((element) =>
    element.scrollIntoView({ block: 'center' }),
  );
  const cdp = await page.context().newCDPSession(page);
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    point?: { x: number; y: number },
  ) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y }] : [],
    });

  const start = await wordAt(region, 'mestre');
  const end = await wordAt(region, 'Tiuako');
  await touch('touchStart', start);
  // Held: the word is chosen and painted before the finger moves (FR-2).
  await expect.poll(() => correcting(page)).toBe('mestre');
  const scrolled = await region.evaluate((element) => element.scrollTop);
  for (let step = 1; step <= 6; step++)
    await touch('touchMove', {
      x: start.x + ((end.x - start.x) * step) / 6,
      y: start.y + ((end.y - start.y) * step) / 6,
    });
  await touch('touchEnd');

  await expect(panel(page)).toHaveAccessibleName(
    'Corrigir palavras, mestre Tiuako',
  );
  await expect(field(page)).toHaveValue('mestre Tiuako');
  expect(await region.evaluate((element) => element.scrollTop)).toBe(scrolled);
  await saveEvidence(page, `${testInfo.project.name}-span-sheet`);
});

test('AC-13: the panel with many words passes axe', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'media-mobile', 'the mouse');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  await drag(textOf(page), 'mestre', 'assim');
  await expect(panel(page)).toBeVisible();
  const violations = (
    await new AxeBuilder({ page }).include('app-track-text').analyze()
  ).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(violations).toEqual([]);
});

const selected = (page: Page) =>
  page.evaluate(() => document.getSelection()?.toString().trim() ?? '');

test('IMP-3: a double click selects the word and a triple click a long line, for copying, and nothing opens', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'media-mobile', 'the mouse');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  const region = textOf(page);

  const word = await wordAt(region, 'Tiuako');
  await page.mouse.dblclick(word.x, word.y);
  await expect.poll(() => selected(page)).toBe('Tiuako');
  await expect(panel(page)).toHaveCount(0);
  await expect(region).toBeFocused();

  // Seven words, more than a correction takes: the whole line is still selected to copy.
  await page.getByRole('button', { name: 'Ver transcrição completa' }).click();
  await expect(region).toContainText('o mestre Tiuako falou na segunda faixa');
  const long = await wordAt(region, 'falou');
  await page.mouse.click(long.x, long.y, { clickCount: 3 });
  await expect
    .poll(() => selected(page))
    .toBe('o mestre Tiuako falou na segunda faixa');
  await expect(panel(page)).toHaveCount(0);
  await expect(region).toBeFocused();
});

test('QA-3: a drag that starts in the space after a word starts on that word', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'media-mobile', 'the mouse');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  const region = textOf(page);

  const end = await wordAt(region, 'disse');
  // Just right of "mestre", in the space before "Tiuako".
  const gap = await region.evaluate((element) => {
    const line = Array.from(element.querySelectorAll('.line')).find((one) =>
      one.textContent?.includes('mestre Tiuako disse'),
    );
    const node = line?.firstChild;
    if (!node?.textContent) return null;
    const at = node.textContent.indexOf('mestre') + 'mestre'.length;
    const range = document.createRange();
    range.setStart(node, at - 1);
    range.setEnd(node, at);
    const box = range.getBoundingClientRect();
    return { x: box.right + 1, y: box.top + box.height / 2 };
  });
  expect(gap).not.toBeNull();
  if (!gap) return;
  await page.mouse.move(gap.x, gap.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect(field(page)).toHaveValue('mestre Tiuako disse');
});

test('AC-9, IMP-4: on a touch screen a quick swipe scrolls the text and opens nothing; a held finger chooses and does not scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'media-mobile', 'the touch screen');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await longLecture(owner);
  await owner.dispose();
  await openStep3(page, media, 'linha 1 fala do mestre');
  const region = textOf(page);
  await expect(region).toContainText('linha 14 fala do mestre');
  const scroll = () => region.evaluate((element) => element.scrollTop);
  const scrollable = await region.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  );
  expect(scrollable, 'the block scrolls').toBe(true);
  const cdp = await page.context().newCDPSession(page);
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    point?: { x: number; y: number },
  ) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y }] : [],
    });

  // Held on "fala" of the first line, then moved down over the lines below: the choice stops
  // at the end of its own line, and the block stays where it was. (Before the swipe: a touch
  // during a swipe's fling cannot hold the scroll back, in Chrome as on a phone.)
  await region.scrollIntoViewIfNeeded();
  await region.evaluate((element) => (element.scrollTop = 0));
  const held = await wordAt(region, 'fala', { scroll: false });
  const before = await scroll();
  await touch('touchStart', held);
  await expect.poll(() => correcting(page)).toBe('fala');
  for (let step = 1; step <= 6; step++)
    await touch('touchMove', { x: held.x, y: held.y + step * 25 });
  await touch('touchEnd');
  await expect(field(page)).toHaveValue('fala do mestre');
  expect(await scroll()).toBe(before);
  await saveEvidence(page, `${testInfo.project.name}-span-held`);
  await panel(page).getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toHaveCount(0);

  // A quick swipe up from a word: the block scrolls, nothing is chosen.
  await region.evaluate((element) => (element.scrollTop = 0));
  const from = await wordAt(region, 'linha 3', { scroll: false });
  const top = await scroll();
  await touch('touchStart', from);
  for (let step = 1; step <= 6; step++)
    await touch('touchMove', { x: from.x, y: from.y - step * 30 });
  await touch('touchEnd');
  await expect.poll(scroll).toBeGreaterThan(top);
  await expect(panel(page)).toHaveCount(0);
  expect(await correcting(page)).toBeNull();
});

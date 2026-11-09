import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { uniqueTag, uploadReady, useTheme } from './media-helpers.js';
import { seedDraft, trackRow } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

// KBC-093: correcting words of the transcript from the track text of step 3 ("Faixas"),
// on a real transcript seeded with known word times (0.3 s apart): the click seeks the
// screen's audio and opens "Corrigir palavra"; the API writes the word in place.

const SPEECH = [
  { at: 5, text: 'abertura da sessão de hoje' },
  /** "Tiuako" starts at 0:12.6. */
  { at: 12, text: 'o mestre Tiuako disse assim' },
  { at: 20, text: 'e Tiuako, voltou depois' },
  { at: 40, text: 'Tiuako falou na segunda faixa' },
];
const TRACKS = [
  { startMs: 0, endMs: 30_000, title: 'Primeira pergunta' },
  { startMs: 30_000, endMs: 60_000, title: 'Segunda pergunta' },
];

interface Media {
  readonly id: string;
  readonly title: string;
}

/** A recording of its own per test: corrections change it (TE-18). */
async function lecture(owner: APIRequestContext): Promise<Media> {
  const media = await uploadReady(owner, {
    title: `Corrigir palavra ${uniqueTag()}`,
    seconds: 70,
    bitrate: '32k',
  });
  await seedTranscript(owner, { id: media.id, raw: rawOf(SPEECH) });
  await seedDraft(owner, media.id, TRACKS);
  return media;
}

const textOf = (page: Page, ordinal: number) =>
  page.getByRole('region', { name: `Texto da faixa ${ordinal}` });

const audition = (page: Page) =>
  page.locator('audio[hidden]:not([data-media-engine])').first();

const panel = (page: Page) =>
  page.getByRole('dialog', { name: /^Corrigir palavra/ });

const field = (page: Page) =>
  panel(page).getByRole('textbox', { name: 'Texto certo' });

async function openStep3(page: Page, media: Media, ordinal = 1) {
  await page.goto(`/midia/${media.id}/faixas`);
  await trackRow(page, ordinal).getByRole('button').first().click();
  await expect(textOf(page, ordinal)).toContainText('Tiuako');
  await expect(audition(page)).toBeAttached();
}

/** Clicks the `nth` "word" of the text where the browser draws it. */
async function clickWord(region: Locator, word: string, nth = 0) {
  const box = await region.evaluate(
    (element, { word, nth }) => {
      const lines = Array.from(element.querySelectorAll('.line'));
      const found = lines
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
      found.node.parentElement?.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(found.node, found.at);
      range.setEnd(found.node, found.at + word.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { word, nth },
  );
  if (!box) throw new Error(`no "${word}" in the text`);
  await region.page().mouse.click(box.x, box.y);
}

const auditionState = (page: Page) =>
  audition(page).evaluate((element) => ({
    time: (element as HTMLAudioElement).currentTime,
    paused: (element as HTMLAudioElement).paused,
  }));

/** The words painted as "being corrected" (NFR-5). */
const correcting = (page: Page) =>
  page.evaluate(() => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const [range] = Array.from(registry.get('correcting-word') ?? []);
    return range?.toString() ?? null;
  });

async function saveEvidence(page: Page, name: string): Promise<void> {
  const dir = process.env['KBC_EVIDENCE_DIR'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  // The page scrolls inside its layout: what matters is the text block and its panel.
  await page
    .locator('app-track-text')
    .first()
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test('AC-1, AC-23, AC-41, NFR-1: a click on a paused text goes to the word and opens the panel; saving shows the word at once, and Desfazer brings it back', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  const region = textOf(page, 1);

  await clickWord(region, 'Tiuako');

  await expect(panel(page)).toHaveAccessibleName('Corrigir palavra, Tiuako');
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('Tiuako');
  await expect.poll(() => correcting(page)).toBe('Tiuako');
  expect((await auditionState(page)).paused).toBe(true);
  await saveEvidence(page, `${testInfo.project.name}-panel`);
  // Paused at the word: the track's ▶ Ouvir starts there (AC-41).
  await page.getByRole('button', { name: '▶ Ouvir' }).click();
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);
  await expect
    .poll(async () => (await auditionState(page)).time)
    .toBeGreaterThanOrEqual(12.5);
  expect((await auditionState(page)).time).toBeLessThan(16);
  await page.getByRole('button', { name: '■ Parar' }).click();
  await field(page).focus();

  await field(page).fill('Tiuaco');
  const started = Date.now();
  await field(page).press('Enter');
  await expect(region).toContainText('o mestre Tiuaco disse assim');
  const elapsed = Date.now() - started;
  expect(elapsed, 'the new word shows within 500 ms').toBeLessThanOrEqual(500);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('app-track-text .notice')).toContainText(
    'Palavra corrigida.',
  );
  await expect(region).toBeFocused();
  await saveEvidence(page, `${testInfo.project.name}-saved`);

  await page
    .locator('app-track-text .notice')
    .getByRole('button', { name: 'Desfazer' })
    .click();
  await expect(region).toContainText('o mestre Tiuako disse assim');
  await expect(
    page.getByRole('button', { name: 'Correções (2)' }),
  ).toBeVisible();
});

test('AC-24: at 390 px the panel is a sheet at the bottom with targets of 44 px and no sideways scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'media-mobile', 'the phone layout');
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  await clickWord(textOf(page, 1), 'Tiuako');
  await expect(panel(page)).toBeVisible();

  const viewport = page.viewportSize();
  const sheet = await panel(page).boundingBox();
  expect(sheet && viewport).toBeTruthy();
  if (!sheet || !viewport) return;
  expect(Math.round(sheet.y + sheet.height)).toBeGreaterThanOrEqual(
    viewport.height - 1,
  );
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  for (const name of ['◀ Anterior', 'Próxima ▶', 'Salvar', 'Cancelar']) {
    const box = await panel(page).getByRole('button', { name }).boundingBox();
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
  }
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(wide).toBeLessThanOrEqual(0);
  await saveEvidence(page, `${testInfo.project.name}-sheet`);
});

test('AC-40, AC-25: with the audio playing, a click keeps it playing from the word', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  await page.getByRole('button', { name: '▶ Ouvir' }).click();
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);

  await clickWord(textOf(page, 1), 'Tiuako', 1);

  await expect(panel(page)).toHaveAccessibleName('Corrigir palavra, Tiuako,');
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);
  const { time } = await auditionState(page);
  expect(time).toBeGreaterThanOrEqual(20.2);
  expect(time).toBeLessThan(23);
});

test('AC-25: in the whole transcript, a click on a word after the track keeps the audio playing from it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  await page.getByRole('button', { name: 'Ver transcrição completa' }).click();
  await expect(textOf(page, 1)).toContainText('Tiuako falou na segunda faixa');
  await page.getByRole('button', { name: '▶ Ouvir' }).click();
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);

  // The third "Tiuako" is at 0:40, in the second track (0:30–1:00).
  await clickWord(textOf(page, 1), 'Tiuako', 2);

  await expect(panel(page)).toHaveAccessibleName('Corrigir palavra, Tiuako');
  await expect
    .poll(async () => (await auditionState(page)).time)
    .toBeGreaterThanOrEqual(40);
  // Still playing well after the click: it does not stop at the track's end (0:30).
  await expect
    .poll(async () => (await auditionState(page)).time, { timeout: 10_000 })
    .toBeGreaterThan(41);
  expect((await auditionState(page)).paused).toBe(false);
});

test('AC-22, AC-45: by keyboard, Procurar palavra leads to the word and the focus comes back to the occurrence', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);

  await page.getByRole('button', { name: 'Procurar palavra' }).click();
  await page.getByRole('searchbox', { name: 'Procurar palavra' }).fill('tiua');
  // The editor's own transcript has times as buttons too: the search's list is apart.
  const hits = page.getByRole('list', { name: 'Ocorrências' });
  const hit = hits.getByRole('button', { name: /0:12/ });
  await expect(hit).toBeVisible();
  await hit.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toHaveAccessibleName('Corrigir palavra, Tiuako');
  await expect(field(page)).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: 'Áudio em 0:12' }),
  ).toHaveCount(1);
  await page.keyboard.type('Tiuaco');
  await page.keyboard.press('Enter');
  await expect(textOf(page, 1)).toContainText('Tiuaco disse');
  await expect(hits.getByRole('button', { name: /0:12/ })).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: 'Palavra corrigida.' }),
  ).toHaveCount(1);
});

test('AC-28, AC-30, AC-35: Corrigir todas changes the chosen occurrences at once, and the history undoes the group', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  await owner.dispose();
  await openStep3(page, media);
  await clickWord(textOf(page, 1), 'Tiuako');
  await panel(page).getByRole('button', { name: 'Corrigir todas' }).click();

  const dialog = page.getByRole('dialog', { name: 'Corrigir todas' });
  await expect(
    dialog.getByRole('radio', { name: 'Nesta faixa (2)' }),
  ).toBeChecked();
  await dialog.getByRole('radio', { name: 'Na gravação inteira (3)' }).check();
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await dialog.getByRole('textbox', { name: 'Texto certo' }).fill('Tiuaco');
  await dialog.getByRole('checkbox').nth(2).uncheck();
  await saveEvidence(page, `${testInfo.project.name}-correct-all`);
  await dialog.getByRole('button', { name: 'Corrigir 2 ocorrências' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(textOf(page, 1)).toContainText('o mestre Tiuaco disse assim');
  await expect(textOf(page, 1)).toContainText('e Tiuaco, voltou');
  await expect(page.locator('app-track-text .notice')).toContainText(
    '2 ocorrências corrigidas.',
  );

  await page.getByRole('button', { name: 'Correções (1)' }).click();
  const history = page.getByRole('dialog', { name: 'Correções' });
  await expect(
    history.getByText('2 ocorrências', { exact: true }),
  ).toBeVisible();
  await saveEvidence(page, `${testInfo.project.name}-history`);
  await history.getByRole('button', { name: 'Desfazer o grupo' }).click();
  await expect(history.locator('.notice')).toHaveText('2 desfeitas.');
  await history.getByRole('button', { name: 'Fechar' }).click();
  await expect(textOf(page, 1)).toContainText('o mestre Tiuako disse assim');
});

test('AC-46, AC-16: who may edit but not correct clicks a word and nothing moves or opens', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const media = await lecture(owner);
  const email = uniqueEmail('sem-correcao');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-edit', 'media-tracks', 'media-library'],
  });
  await owner.dispose();
  const page = await pageAs(
    browser,
    email,
    testInfo.project.use.viewport ?? null,
  );
  await openStep3(page, media);
  await clickWord(textOf(page, 1), 'Tiuako');
  await expect(textOf(page, 1)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Procurar palavra' }),
  ).toHaveCount(0);
  expect((await auditionState(page)).time).toBe(0);
  await page.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const)
  test(`NFR-4: the panel passes axe in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const owner = await ownerApi();
    const media = await lecture(owner);
    await owner.dispose();
    await useTheme(page, theme);
    await openStep3(page, media);
    await clickWord(textOf(page, 1), 'Tiuako');
    await expect(panel(page)).toBeVisible();
    const violations = (
      await new AxeBuilder({ page }).include('app-track-text').analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
    await saveEvidence(page, `${testInfo.project.name}-panel-${theme}`);
  });

import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import {
  aCollection,
  audioState,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';
import { approve, seedDraft } from './tracks-helpers.js';

/** KBC-096: the library's search answers with tracks, the speech first (screens.md T16). */

const LISTENER = ['media', 'media-library', 'media-tracks', 'search'];
const TRACKS = [
  { startMs: 0, endMs: 15_000, title: 'Infância' },
  { startMs: 15_000, endMs: 40_000, title: 'O encontro' },
  { startMs: 40_000, endMs: 59_000, title: 'Velhice' },
];

/** Letters only: a word the index reads whole, said in this run alone. */
const lettersOf = (tag: string) => tag.replace(/[^a-z]/g, '').padEnd(6, 'x');

const segment = (at: number, text: string) => ({
  start: at,
  end: at + 4,
  text: ` ${text}`,
  avg_logprob: -0.2,
  compression_ratio: 1.3,
  no_speech_prob: 0.01,
  words: text.split(' ').map((word, i, all) => ({
    word: ` ${word}`,
    start: at + (i * 4) / all.length,
    end: at + ((i + 1) * 4) / all.length,
    probability: 0.95,
  })),
});

async function say(
  owner: APIRequestContext,
  mediaId: string,
  passages: readonly (readonly [number, string])[],
): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await owner.post(`/api/e2e/media/${mediaId}/transcript`, {
            data: {
              raw: {
                chunks: [
                  {
                    offset: 0,
                    end: Math.max(...passages.map(([at]) => at)) + 10,
                    result: {
                      segments: passages.map(([at, text]) => segment(at, text)),
                    },
                  },
                ],
              },
            },
            headers: CSRF,
          })
        ).status(),
      { timeout: 30_000 },
    )
    .toBe(204);
}

async function published(owner: APIRequestContext, mediaId: string) {
  await expect
    .poll(
      async () => {
        const edit = await owner.get(`/api/v1/media/${mediaId}/edit`);
        return ((await edit.json()) as { preparation: unknown }).preparation;
      },
      { timeout: 30_000 },
    )
    .toBeNull();
}

let collection: string;
let word: string;
let longWord: string;
let interview: UploadedMedia;
let single: UploadedMedia;

test.beforeAll(async () => {
  const tag = uniqueTag();
  word = `orlando${lettersOf(tag)}`;
  longWord = `comprido${lettersOf(tag)}`;
  const owner = await ownerApi();
  collection = await aCollection(owner);
  interview = await uploadReady(owner, {
    title: `Entrevista ${tag}`,
    seconds: 60,
    topic: collection,
  });
  await say(owner, interview.id, [
    [2, 'começo da vida no interior'],
    [20, `conheci o Padre ${word} em Manaus`],
    [45, `o padre ${word} voltou depois`],
  ]);
  await seedDraft(owner, interview.id, TRACKS);
  await approve(owner, interview.id);
  await published(owner, interview.id);
  single = await uploadReady(owner, {
    title: `Palestra ${tag}`,
    seconds: 12,
    topic: collection,
  });
  const filler = (word: string) =>
    Array.from({ length: 70 }, (_, n) => `${word}${n}`).join(' ');
  await say(owner, single.id, [
    [3, `${filler('antes')} ${longWord} ${filler('depois')}`],
  ]);
  await owner.dispose();
});

const viewportOf = () => test.info().project.use.viewport ?? null;

async function listener(
  browser: Browser,
  features: readonly string[] = LISTENER,
): Promise<Page> {
  const email = uniqueEmail('busca');
  const owner = await ownerApi();
  await invite(owner, email, { topics: [collection], features });
  await owner.dispose();
  return pageAs(browser, email, viewportOf());
}

const box = (page: Page) => page.getByLabel('Buscar na biblioteca');
const results = (page: Page) =>
  page.locator('app-library-search-results').getByRole('listitem');
/** The answer to the words now in the box is on screen, not the last one kept there. */
const answered = (page: Page) =>
  expect(page.locator('app-library-search-results section')).toHaveAttribute(
    'aria-busy',
    'false',
  );
const status = (page: Page) =>
  page.locator('app-library-page').getByRole('status');

async function openLibrary(page: Page) {
  await page.goto('/biblioteca');
  await expect(box(page)).toBeVisible();
}

test('AC-1, AC-7: only the tracks that say the words, first under the box, whatever the case', async ({
  browser,
}) => {
  const page = await listener(browser);
  const saved = await page.request.put(`/api/v1/media/${single.id}/progress`, {
    data: { positionMs: 2_000, basedOn: null },
    headers: CSRF,
  });
  expect(saved.status()).toBe(200);
  await openLibrary(page);
  const strip = page.getByRole('region', { name: 'Continuar ouvindo' });
  await expect(strip).toBeVisible();

  for (const words of [
    `padre ${word}`,
    `Padre ${word.toUpperCase()}`,
    `${word}`,
  ]) {
    await box(page).fill(words);
    await expect(strip).toHaveCount(0);
    await answered(page);
    await expect(results(page)).toHaveCount(2);
    await expect(results(page).first().locator('mark').first()).toBeVisible();
    await expect(status(page)).toContainText('2 resultados');
  }

  await expect(page.getByRole('region', { name: 'Todas' })).toHaveCount(0);
  await expect(page.getByText('Ouvidas recentemente')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Ordenar/ })).toHaveCount(0);
  const under = await box(page).boundingBox();
  const first = await results(page).first().boundingBox();
  expect((first?.y ?? 0) - (under?.y ?? 0)).toBeLessThan(180);
  const encounter = results(page).filter({ hasText: 'O encontro' });
  await expect(encounter).toContainText(`${interview.title} · faixa 2 de 3`);
  await expect(encounter).toContainText('em Manaus');
  // Each track with its own passage: the screenshot once caught both with the first's.
  await expect(results(page).filter({ hasText: 'Velhice' })).toContainText(
    'voltou depois',
  );
  await page.context().close();
});

test('AC-8: ▶ plays 2 s before the passage, the title opens there, Back keeps the search', async ({
  browser,
}) => {
  const page = await listener(browser);
  await openLibrary(page);
  await box(page).fill(word);
  const row = results(page).filter({ hasText: 'O encontro' });
  await row.getByRole('button', { name: /^Ouvir o trecho/ }).click();
  await expect(row.getByRole('button', { name: /^Pausar/ })).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(3);
  expect((await audioState(page)).currentTime).toBeLessThan(10);
  await expect(page).toHaveURL(/\/biblioteca/);
  await row.getByRole('button', { name: /^Pausar/ }).click();

  await row.getByRole('link', { name: 'O encontro' }).click();
  await expect(page).toHaveURL(/\/midia\/[^?]+\?t=3$/);
  await page.goBack();
  await expect(box(page)).toHaveValue(word);
  await expect(results(page)).toHaveCount(2);
  await page.context().close();
});

test('AC-4: without `search` a spoken word finds nothing, and the message does not promise it', async ({
  browser,
}) => {
  const page = await listener(browser, [
    'media',
    'media-library',
    'media-tracks',
  ]);
  await openLibrary(page);
  await box(page).fill(word);
  await expect(page.getByText(/Nada encontrado/)).toContainText(
    'no título, no autor ou nos assuntos',
  );
  await expect(page.getByText(/Nada encontrado/)).not.toContainText('fala');
  await box(page).fill('o encontro');
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).locator('mark')).toHaveCount(0);
  await page.context().close();
});

test('AC-6: a recording found by title is one row, and the Acervo stays in reach', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const other = await aCollection(owner);
  const email = uniqueEmail('acervos');
  await invite(owner, email, {
    topics: [collection, other],
    features: LISTENER,
  });
  await uploadReady(owner, {
    title: `Outra ${interview.title}`,
    seconds: 2,
    topic: other,
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewportOf());
  await openLibrary(page);
  await box(page).fill(interview.title);
  await expect(results(page)).toHaveCount(2);
  await expect(
    results(page).filter({ hasText: 'Gravação completa · 3 faixas' }),
  ).toHaveCount(1);

  await page
    .locator('app-library-controls')
    .getByRole('combobox', { name: 'Acervo' })
    .selectOption(other);
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText(`Outra ${interview.title}`);
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(results(page)).toHaveCount(2);
  await page.context().close();
});

test('AC-9: nothing found says where it looked, and "Limpar busca" returns to the box', async ({
  browser,
}) => {
  const page = await listener(browser);
  await openLibrary(page);
  await box(page).fill('xylofone');
  await expect(
    page.getByText(
      "Nada encontrado para 'xylofone' na fala, no título, no autor ou nos assuntos.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Buscar na fala' }),
  ).toHaveCount(0);
  await page
    .locator('app-library-search-results')
    .getByRole('button', { name: 'Limpar busca' })
    .click();
  await expect(box(page)).toHaveValue('');
  await expect(box(page)).toBeFocused();
  await expect(page.getByRole('region', { name: 'Todas' })).toBeVisible();
  await page.context().close();
});

test('AC-10: a long passage shows the word and never widens the page', async ({
  browser,
}) => {
  const page = await listener(browser);
  await openLibrary(page);
  await box(page).fill(longWord);
  const row = results(page).first();
  await expect(row.locator('mark')).toHaveText(longWord);
  await expect(row.locator('mark')).toBeInViewport();
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.context().close();
});

test('AC-11: by keyboard from the box to the player, and axe finds nothing serious', async ({
  browser,
}) => {
  const page = await listener(browser);
  await useTheme(page, 'dark');
  await openLibrary(page);
  await box(page).fill(word);
  await expect(results(page)).toHaveCount(2);
  await expect(status(page)).toContainText(`2 resultados: ${word}`);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.filter((one) =>
      ['serious', 'critical'].includes(one.impact ?? ''),
    ),
  ).toEqual([]);

  await box(page).focus();
  await page.keyboard.press('Tab'); // ✕
  await expect(
    page.getByRole('button', { name: 'Limpar busca' }),
  ).toBeFocused();
  const link = results(page).first().getByRole('link');
  const play = results(page).first().getByRole('button');
  for (let press = 0; press < 6; press++) {
    await page.keyboard.press('Tab');
    if (await play.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(play).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/midia\/[^?]+\?t=\d+$/);
  await page.context().close();
});

test('AC-12: a slow answer to older words never replaces the new one', async ({
  browser,
}) => {
  const page = await listener(browser);
  await openLibrary(page);
  await page.route('**/api/v1/media/library/search?*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'interior') await new Promise((done) => setTimeout(done, 1_500));
    await route.continue().catch(() => undefined);
  });
  await box(page).fill('interior');
  await page.waitForRequest((request) => request.url().includes('q=interior'));
  await box(page).fill(word);
  await expect(results(page)).toHaveCount(2);
  await page.waitForTimeout(1_800);
  await expect(results(page)).toHaveCount(2);
  await expect(results(page).first()).toContainText(word);
  await page.context().close();
});

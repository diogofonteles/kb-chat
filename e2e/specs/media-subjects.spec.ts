import AxeBuilder from '@axe-core/playwright';
import type {
  APIRequestContext,
  Browser,
  Page,
  ViewportSize,
} from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { uniqueTag, useTheme } from './media-helpers.js';
import { startInSearchView } from './search-view.js';
import { approve, audioWithTracks } from './tracks-helpers.js';

// KBC-070: subjects reach the search, the concept's panel, the track's page and the library.

const TOPIC = 'hermetismo';
const READER = ['search', 'media', 'media-library', 'media-tracks'];

test.beforeEach(startInSearchView);

interface Seeded {
  readonly trackId: string;
  readonly title: string;
  readonly subject: string;
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

async function newFreeSubject(owner: APIRequestContext, name: string) {
  const made = await owner.post(`/api/v1/topics/${TOPIC}/subjects`, {
    data: { name },
    headers: CSRF,
  });
  expect(made.status(), await made.text()).toBe(201);
  return ((await made.json()) as { id: string }).id;
}

/** A published track linked to Cabala and to a free subject of this test alone. */
async function trackWithSubjects(owner: APIRequestContext): Promise<Seeded> {
  const tag = uniqueTag();
  const title = `Pergunta sobre o tema ${tag}`;
  const subject = `Assunto ${tag}`;
  const media = await audioWithTracks(owner, [
    { startMs: 0, endMs: 15_000, title },
    { startMs: 15_000, endMs: 40_000, title: 'Outra pergunta' },
  ]);
  await approve(owner, media.id);
  await published(owner, media.id);
  const step = await owner.get(`/api/v1/media/${media.id}/edit/subjects`);
  const { tracks } = (await step.json()) as {
    tracks: { mediaId: string; version: number }[];
  };
  const track = tracks[0];
  if (!track) throw new Error('no track');
  const id = await newFreeSubject(owner, subject);
  const saved = await owner.put(`/api/v1/media/${track.mediaId}/subjects`, {
    data: {
      subjects: [
        { kind: 'concept', name: 'Cabala' },
        { kind: 'free', id },
      ],
      summary: 'Uma resposta sobre o que a pergunta traz.',
    },
    headers: { ...CSRF, 'if-match': `"${track.version}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  return { trackId: track.mediaId, title, subject };
}

async function reader(
  browser: Browser,
  viewport: ViewportSize | null,
  features: readonly string[] = [...READER, 'media-subjects'],
) {
  const owner = await ownerApi();
  const email = uniqueEmail('assuntos');
  await invite(owner, email, { topics: [TOPIC], features: [...features] });
  await owner.dispose();
  return pageAs(browser, email, viewport);
}

const seeded = async () => {
  const owner = await ownerApi();
  const seed = await trackWithSubjects(owner);
  await owner.dispose();
  return seed;
};

const seriousIn = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter(
    (one) => one.impact === 'serious' || one.impact === 'critical',
  );
};

const expectClean = async (page: Page) => {
  expect((await seriousIn(page)).map((one) => one.id)).toEqual([]);
};

/** From the track's page, its free subject's chip: the filtered search. */
async function searchByChip(page: Page, { trackId, subject }: Seeded) {
  await page.goto(`/midia/${trackId}`);
  await page.getByRole('button', { name: `Buscar por ${subject}` }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('AC-1, track page: the chip opens the search with the track and its subject', async ({
  browser,
  viewport,
}) => {
  const seed = await seeded();
  const page = await reader(browser, viewport);
  await page.goto(`/midia/${seed.trackId}`);
  await expect(
    page.getByText('Uma resposta sobre o que a pergunta traz.'),
  ).toBeVisible();
  await expect(page.getByText('Assuntos:')).toBeVisible();
  await searchByChip(page, seed);

  const card = page.locator(`[data-media-id="${seed.trackId}"]`);
  await expect(card).toContainText('Faixa · Assunto');
  await expect(card).toContainText(seed.title);
  await expect(card).toContainText('Cabala');
  await expect(
    page.getByRole('button', { name: `Remover Assuntos: ${seed.subject}` }),
  ).toBeVisible();

  await card.click();
  await expect(
    page.getByRole('heading', { level: 2, name: seed.title }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Abrir na página/ }),
  ).toHaveAttribute('href', new RegExp(`/midia/${seed.trackId}`));
  await page.context().close();
});

test('AC-4: the subject filter says documents and tracks apart', async ({
  browser,
  viewport,
}) => {
  await seeded();
  const page = await reader(browser, viewport);
  await page.goto('/');
  await page.getByRole('button', { name: 'Cabala', exact: true }).click();
  await page
    .getByRole('button', { name: /^Assuntos/ })
    .first()
    .click();
  await expect(
    page
      .getByRole('group', { name: 'Assuntos' })
      .getByText(/\d+ · \d+ faixas?/),
  ).toBeVisible();
  await page.context().close();
});

test('AC-5: the concept panel lists the tracks, each opening at the start', async ({
  browser,
  viewport,
}) => {
  const seed = await seeded();
  const page = await reader(browser, viewport);
  await page.goto('/');
  // An Enter before the collection loads is dropped: the button says it can search.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Hermetismo',
  );
  await page.getByLabel('Sua pergunta').fill('sephiroth');
  const send = page.getByRole('button', { name: 'Buscar' });
  await expect(send).toBeEnabled();
  await send.click();
  await page
    .getByRole('button', { name: /A Árvore da Vida/ })
    .first()
    .click();
  const panel = page.getByRole('dialog');
  await panel
    .getByRole('button', { name: 'Cabala', exact: true })
    .last()
    .click();
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Cabala');
  await expect(
    page.getByRole('heading', {
      name: 'Perguntas e respostas sobre este assunto',
    }),
  ).toBeVisible();
  const more = page.getByRole('button', { name: /^Ver todas/ });
  if (await more.isVisible()) await more.click();
  await page.getByRole('link', { name: seed.title }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${seed.trackId}\\?t=0`));
  await expect(
    page.getByRole('heading', { level: 2, name: seed.title }),
  ).toBeVisible();
  await page.context().close();
});

test('AC-7: "Assunto" in the library lists only the linked tracks, and comes back', async ({
  browser,
  viewport,
}) => {
  const seed = await seeded();
  const page = await reader(browser, viewport);
  await page.goto('/biblioteca');
  const choice = page.getByRole('combobox', { name: 'Assunto' });
  await choice.selectOption({ label: seed.subject });
  await expect(page.getByText(/^1 mídia/)).toBeVisible();
  await expect(page.getByRole('link', { name: seed.title })).toBeVisible();

  await expect
    .poll(async () => {
      await page.goto('/biblioteca');
      return page.getByRole('combobox', { name: 'Assunto' }).inputValue();
    })
    .toMatch(/^free:/);
  await expect(page.getByRole('link', { name: seed.title })).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(choice).toHaveValue('');
  await page.context().close();
});

test('AC-6: without `media-subjects` nothing of a subject shows', async ({
  browser,
  viewport,
}) => {
  const seed = await seeded();
  const page = await reader(browser, viewport, READER);
  await page.goto(`/midia/${seed.trackId}`);
  await expect(
    page.getByRole('heading', { level: 2, name: seed.title }),
  ).toBeVisible();
  await expect(page.getByText('Assuntos:')).toHaveCount(0);
  // A subject saved while the person still had the feature: left aside, not a filter.
  const saved = await page.request.put('/api/v1/media/preferences', {
    headers: CSRF,
    data: {
      libraryFilters: {
        states: [],
        authors: [],
        topic: null,
        subject: 'concept:cabala',
      },
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto('/biblioteca');
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Assunto' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Limpar filtros' }),
  ).toHaveCount(0);
  await page.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const)
  test(`AC-8: no serious axe violation with the ${theme} theme`, async ({
    browser,
    viewport,
  }) => {
    const seed = await seeded();
    const page = await reader(browser, viewport);
    await useTheme(page, theme);
    await page.goto(`/midia/${seed.trackId}`);
    await expect(page.getByText('Assuntos:')).toBeVisible();
    await expectClean(page);
    await searchByChip(page, seed);
    await expect(
      page.locator(`[data-media-id="${seed.trackId}"]`),
    ).toBeVisible();
    await expectClean(page);
    await page.goto('/biblioteca');
    await expect(page.getByRole('combobox', { name: 'Assunto' })).toBeVisible();
    await expectClean(page);
    await page.context().close();
  });

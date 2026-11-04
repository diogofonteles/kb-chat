import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { audioState } from './media-helpers.js';
import { approve, audioWithTracks } from './tracks-helpers.js';

// KBC-068: approved tracks as items of their own, cut for real by the E2E's media worker.

const FIRST_TWO = [
  { startMs: 0, endMs: 15_000, title: 'Primeira pergunta' },
  { startMs: 15_000, endMs: 40_000, title: 'Segunda pergunta' },
];

/** Waits for the real worker to cut and publish every track. */
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

async function approvedAudio(owner: APIRequestContext) {
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await published(owner, media.id);
  return media;
}

/** The recording's row or card, by its title, in the library's list. */
const openTracks = async (page: Page, title: string) => {
  await page.goto('/biblioteca');
  await page.getByRole('searchbox').fill(title);
  // Only this recording left: the search is debounced, and "Continuar ouvindo" stays above.
  await expect(page.getByText(/^1 mídia/)).toBeVisible();
};

test('AC-3, AC-2: the library shows the tracks; a track says where it comes from and plays its part', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  await openTracks(page, media.title);
  await expect(page.getByRole('button', { name: '3 faixas' })).toBeVisible();
  const list = page.getByRole('list', { name: `Faixas de ${media.title}` });
  await list.getByRole('link', { name: 'Segunda pergunta' }).click();

  await expect(
    page.getByRole('heading', { name: 'Segunda pergunta' }),
  ).toBeVisible();
  await expect(page.getByText('faixa 2 de 3')).toBeVisible();
  await expect(page.getByRole('link', { name: media.title })).toBeVisible();
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).duration)
    .toBeGreaterThan(24.5);
  expect((await audioState(page)).duration).toBeLessThan(25.5);

  await page.getByRole('link', { name: 'Ouvir no contexto' }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${media.id}\\?t=15`));
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  await owner.dispose();
});

test('AC-3, FR-5: in the grid, the tracks answer to the pointer and show their titles', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  // The view follows the account: a person of its own keeps the owner's list.
  const email = uniqueEmail('grade');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-library', 'media-tracks'],
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await openTracks(page, media.title);
  await page.getByRole('button', { name: 'Ver em grade' }).click();

  // A search opens the group: the pointer closes it, then opens it again.
  const toggle = page.getByRole('button', { name: '3 faixas' });
  const list = page.getByRole('list', { name: `Faixas de ${media.title}` });
  await expect(list).toBeVisible();
  await toggle.click();
  await expect(list).toBeHidden();
  await toggle.click();
  await expect(list).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca/);

  const title = list.getByRole('link', { name: 'Segunda pergunta' });
  const isCut = await title.evaluate(
    (link) => link.scrollWidth > link.clientWidth,
  );
  expect(isCut).toBe(false);

  await page.getByRole('button', { name: 'Ouvir Segunda pergunta' }).click();
  await expect(
    page.getByRole('button', { name: 'Pausar Segunda pergunta' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca/);

  await title.click();
  await expect(
    page.getByRole('heading', { name: 'Segunda pergunta' }),
  ).toBeVisible();
});

test('NG-30: the links of a track pass axe', async ({ page }) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  const listed = await owner.get('/api/v1/media/library');
  const { items } = (await listed.json()) as {
    items: { id: string; tracks: { id: string }[] }[];
  };
  const trackId = items.find((item) => item.id === media.id)?.tracks[0]?.id;
  await page.goto(`/midia/${trackId}`);
  const context = page.getByRole('link', { name: 'Ouvir no contexto' });
  await expect(context).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('.part-of')
    .withRules(['target-size'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await owner.dispose();
});

test('AC-3: without media-tracks the recording stands alone', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  const email = uniqueEmail('sem-faixas');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-library'],
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await openTracks(page, media.title);
  await expect(page.getByRole('button', { name: /faixas$/ })).toHaveCount(0);
});

test('AC-5: a track that leaves the edit says so on its page', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  const listed = await owner.get('/api/v1/media/library');
  const { items } = (await listed.json()) as {
    items: { id: string; tracks: { id: string; title: string }[] }[];
  };
  const third = items
    .find((item) => item.id === media.id)
    ?.tracks.find((track) => track.title === 'Terceira pergunta');
  const reopened = await owner.post(`/api/v1/media/${media.id}/edit/reopen`, {
    data: {},
    headers: { ...CSRF, 'if-match': '"2"' },
  });
  expect(reopened.status(), await reopened.text()).toBe(200);
  const removed = await owner.get(`/api/v1/media/${media.id}/edit`);
  const { version } = (await removed.json()) as { version: number };
  const saved = await owner.put(`/api/v1/media/${media.id}/edit`, {
    data: {
      step: 3,
      tracks: FIRST_TWO.map((track) => ({
        ...track,
        id: randomUUID(),
        source: 'manual',
        kind: 'qa',
        askerVoice: null,
        answererVoice: null,
        askerSpeakerId: null,
        answererSpeakerId: null,
      })),
    },
    headers: { ...CSRF, 'if-match': `"${version}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const approved = await owner.post(`/api/v1/media/${media.id}/edit/approve`, {
    data: {},
    headers: { ...CSRF, 'if-match': `"${version + 1}"` },
  });
  expect(approved.status(), await approved.text()).toBe(200);
  await page.goto(`/midia/${third?.id}`);
  await expect(page.getByText('Faixa removida da edição')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Ouvir no contexto' }),
  ).toBeVisible();
  await expect(page.getByText(/faixa \d+ de/)).toHaveCount(0);
  await owner.dispose();
});

test('removing a recording names the tracks that go with it', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  await openTracks(page, media.title);
  await page
    .getByRole('button', { name: `Mais ações para ${media.title}` })
    .click();
  await page.getByRole('menuitem', { name: 'Remover' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Remover' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Também remove 3 faixas: Primeira pergunta, Segunda pergunta, Terceira pergunta',
  );
  await dialog.getByRole('button', { name: 'Remover' }).click();
  await expect(
    page.getByRole('status').getByText(`${media.title} foi removido.`),
  ).toBeVisible();
  await owner.dispose();
});

import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import {
  approve,
  audioWithTracks,
  draftTracks,
  expectSaved,
  handle,
  trackRow,
} from './tracks-helpers.js';

// KBC-066: what happens when a save does not go through. Nothing is applied that a person
// did not press for on this draft (BR-1), and no change is lost (BR-6, FR-10).

const open = async (page: Page, id: string) => {
  await page.goto(`/midia/${id}/faixas`);
  await expect(page.getByTestId('step-text')).toContainText(
    /3.*Validar faixas/,
  );
};

/** Another writer gets ahead of this page. */
async function otherSaves(owner: APIRequestContext, id: string) {
  const read = await owner.get(`/api/v1/media/${id}/edit`);
  const edit = (await read.json()) as {
    version: number;
    tracks: Record<string, unknown>[];
  };
  const tracks = edit.tracks.map((track) => ({
    id: track['id'],
    source: track['source'],
    startMs: track['startMs'],
    endMs: track['endMs'],
    kind: track['kind'],
    title: 'Da outra pessoa',
    askerVoice: null,
    answererVoice: null,
    askerSpeakerId: null,
    answererSpeakerId: null,
  }));
  const saved = await owner.put(`/api/v1/media/${id}/edit`, {
    data: { step: 3, tracks },
    headers: { ...CSRF, 'if-match': `"${edit.version}"` },
  });
  expect(saved.status()).toBe(200);
}

const shortenFirst = async (page: Page) => {
  await handle(page, 'Fim da faixa 1').focus();
  await page.keyboard.press('Alt+ArrowLeft');
};

const refusePuts = (page: Page, id: string, status: number) =>
  page.route(`**/api/v1/media/${id}/edit`, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status,
          json: { error: { code: 'INTERNAL', message: 'no' } },
        })
      : route.continue(),
  );

const approvalStatus = async (owner: APIRequestContext, id: string) => {
  const read = await owner.get(`/api/v1/media/${id}/edit`);
  return ((await read.json()) as { status: string }).status;
};

test('BR-1: Aprovar in a conflict does nothing, then or after a reload and a save', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await otherSaves(owner, media.id);
  await shortenFirst(page);
  await expect(page.getByRole('alert')).toContainText('Outra pessoa mudou');
  const approveButton = page.getByRole('button', { name: 'Aprovar faixas' });
  await approveButton.click();
  await expect(page.getByText(/Nada foi feito: esta edição/)).toBeVisible();
  await expect(approveButton).toBeEnabled();

  await page.getByRole('button', { name: 'Recarregar' }).click();
  await expect(trackRow(page, 1)).toContainText('Da outra pessoa');
  await expect(approveButton).toBeEnabled();
  await shortenFirst(page);
  await expect(page.getByText('Rascunho salvo').first()).toBeVisible();
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  expect(await approvalStatus(owner, media.id)).toBe('draft');
  await owner.dispose();
});

for (const status of [500, 429, 503]) {
  test(`BR-1: a save refused with ${status} approves nothing and says so`, async ({
    page,
  }) => {
    const owner = await ownerApi();
    const media = await audioWithTracks(owner);
    await open(page, media.id);
    await refusePuts(page, media.id, status);
    await shortenFirst(page);
    await page.getByRole('button', { name: 'Aprovar faixas' }).click();
    await expect(
      page.getByText('Nada foi feito: não consegui salvar a última mudança.'),
    ).toBeVisible();
    expect(await approvalStatus(owner, media.id)).toBe('draft');
    await expect(
      page.getByRole('textbox', { name: 'Suas faixas, para copiar' }),
    ).toHaveValue(/0:14,5 Primeira pergunta/);

    await page.unroute(`**/api/v1/media/${media.id}/edit`);
    await page.getByRole('button', { name: 'Tentar de novo' }).click();
    await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
    expect(await approvalStatus(owner, media.id)).toBe('draft');
    await owner.dispose();
  });
}

test('FR-10, AC-15: who is late after an approval keeps the change to copy', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await approve(owner, media.id);
  await shortenFirst(page);
  await expect(page.getByRole('alert')).toContainText(
    'Outra pessoa mudou esta edição',
  );
  await expect(
    page.getByRole('textbox', { name: 'Suas faixas, para copiar' }),
  ).toHaveValue(/0:14,5 Primeira pergunta · Pergunta e resposta/);
  await page.getByRole('button', { name: 'Recarregar' }).click();
  await expect(
    page.getByRole('heading', { name: '3 faixas aplicadas.' }),
  ).toBeVisible();
  await owner.dispose();
});

test('UP-04: "Sair e continuar depois" leaves a conflict, and the tracks are there on return', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await otherSaves(owner, media.id);
  await shortenFirst(page);
  await expect(page.getByRole('alert')).toContainText('Outra pessoa mudou');
  await page.getByRole('button', { name: 'Sair e continuar depois' }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${media.id}$`));
  await page.getByRole('link', { name: 'Continuar' }).click();
  await expect(page.getByRole('alert')).toContainText('Outra pessoa mudou');
  await expect(
    page.getByRole('textbox', { name: 'Suas faixas, para copiar' }),
  ).toHaveValue(/0:14,5 Primeira pergunta/);
  const { violations } = await new AxeBuilder({ page })
    .include('app-track-editor-page')
    .analyze();
  expect(
    violations.filter((one) =>
      ['serious', 'critical'].includes(one.impact ?? ''),
    ),
  ).toEqual([]);
  await owner.dispose();
});

test('BR-6: going back within the save delay keeps the change', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await page.goto(`/midia/${media.id}`);
  await page.getByRole('link', { name: 'Continuar' }).click();
  await expect(page.getByTestId('step-text')).toContainText('Validar faixas');
  await shortenFirst(page);
  await page.goBack();
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  await owner.dispose();
});

test('BR-6: reloading within the save delay keeps the change', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await shortenFirst(page);
  await page.reload();
  await expect(page.getByTestId('step-text')).toContainText('Validar faixas');
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  await expect(trackRow(page, 1)).toContainText('0:14,5');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await owner.dispose();
});

test('BR-6: closing the tab within the save delay keeps the change', async ({
  page,
  context,
  browserName,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await shortenFirst(page);
  await page.close({ runBeforeUnload: true });
  // WebKit drops the request of a closing page; opening again sends what it kept.
  if (browserName === 'webkit') await open(await context.newPage(), media.id);
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  await owner.dispose();
});

test('offline: the banner, the queue and the save on return', async ({
  page,
  context,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await context.setOffline(true);
  await shortenFirst(page);
  await expect(page.getByText(/Sem conexão: suas mudanças/)).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press('Alt+ArrowLeft');
  await context.setOffline(false);
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_000);
  await expect(page.getByText('Sem conexão')).toHaveCount(0);
  await owner.dispose();
});

test('offline: what the screen promises survives a reload (R-2)', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await page.route(`**/api/v1/media/${media.id}/edit`, (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await shortenFirst(page);
  await expect(page.getByText(/ficam neste aparelho/)).toBeVisible();
  await page.unroute(`**/api/v1/media/${media.id}/edit`);
  await page.reload();
  await expect(page.getByText(/Recuperei mudanças/)).toBeVisible();
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  await owner.dispose();
});

test('I-4: a save whose answer was lost is not a conflict with oneself', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  let lost = false;
  await page.route(`**/api/v1/media/${media.id}/edit`, async (route) => {
    if (route.request().method() !== 'PUT' || lost) return route.continue();
    lost = true;
    await route.fetch();
    return route.abort();
  });
  await shortenFirst(page);
  await expect(page.getByText(/ficam neste aparelho/)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('Rascunho salvo').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await draftTracks(owner, media.id))[0]?.endMs).toBe(14_500);
  await owner.dispose();
});

test('R-4: a tap on a handle moves nothing, on the whole target', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, [
    { startMs: 20_000, endMs: 40_000, title: 'Faixa' },
  ]);
  await open(page, media.id);
  const start = handle(page, 'Início da faixa 1');
  const box = await start.boundingBox();
  if (!box) throw new Error('no handle');
  const y = box.y + 30;
  await page.mouse.click(box.x + 2, y);
  await page.mouse.click(box.x + box.width - 2, y);
  await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.startMs === 20_500);
  await owner.dispose();
});

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

/** Counts what leaves this page: only a press may send either (BR-1). */
function pressesSent(page: Page, id: string) {
  const sent = { approvals: 0, runs: 0 };
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith(`/media/${id}/edit/approve`))
      sent.approvals += 1;
    if (request.url().endsWith(`/media/${id}/edit/proposals`)) {
      const { dryRun } = request.postDataJSON() as { dryRun?: boolean };
      if (!dryRun) sent.runs += 1;
    }
  });
  return sent;
}

/** PUTs wait for `release`: a press stays on hold for as long as the test looks at it. */
async function holdSaves(page: Page, id: string) {
  let release = () => undefined as void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/media/${id}/edit`, async (route) => {
    if (route.request().method() === 'PUT') await released;
    await route.fallback();
  });
  return release;
}

/** The analysis answers with a cheap estimate and refuses to run: no money moves here. */
const stubProposals = (page: Page, id: string) =>
  page.route(new RegExp(`/api/v1/media/${id}/edit/proposals$`), (route) => {
    const { dryRun } = route.request().postDataJSON() as { dryRun?: boolean };
    return dryRun
      ? route.fulfill({
          json: {
            allowed: true,
            estimateUsd: 0.02,
            runCapUsd: 0.25,
            windows: 2,
            model: 'stub',
            refusal: null,
            month: { spentUsd: 1.5, capUsd: 10 },
          },
        })
      : route.fulfill({
          status: 500,
          json: { error: { code: 'INTERNAL', message: 'no' } },
        });
  });

test('BUG-5: two presses in one task send one approval, and no false conflict', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  const sent = pressesSent(page, media.id);
  await open(page, media.id);
  await shortenFirst(page);
  await page.evaluate(() => {
    const press = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Aprovar faixas'),
    );
    press?.click();
    press?.click();
  });
  await expect(
    page.getByRole('heading', { name: '3 faixas aplicadas.' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(sent.approvals).toBe(1);
  await owner.dispose();
});

test('BUG-6: a second change during a save, then a reload: the last change stays', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  let arrived = false;
  let answer = () => undefined as void;
  const answerHeld = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route(`**/api/v1/media/${media.id}/edit`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    // The write lands at once; its answer does not come while the page lives.
    const response = await route.fetch();
    arrived = true;
    await answerHeld;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await shortenFirst(page);
  await expect.poll(() => arrived).toBe(true);
  await page.keyboard.press('Alt+ArrowLeft');
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  await page.unroute(`**/api/v1/media/${media.id}/edit`);
  await page.reload();
  await expect(page.getByText(/Recuperei mudanças/)).toBeVisible();
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_000);
  await expect(page.getByRole('alert')).toHaveCount(0);
  answer();
  await owner.dispose();
});

test('F-1: leaving offline from a page opened straight says why, and works back online', async ({
  page,
  context,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await handle(page, 'Fim da faixa 1').waitFor();
  await context.setOffline(true);
  await shortenFirst(page);
  const leave = page.getByRole('button', { name: 'Sair e continuar depois' });
  await leave.click();
  await expect(page.getByText(/Não consegui abrir a página/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/midia/${media.id}/faixas$`));
  await context.setOffline(false);
  await leave.click();
  await expect(page).toHaveURL(new RegExp(`/midia/${media.id}$`));
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);
  await owner.dispose();
});

test('F-2: "Confirmar e propor" waits for an approval on hold', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await stubProposals(page, media.id);
  const sent = pressesSent(page, media.id);
  await open(page, media.id);
  await page.getByRole('button', { name: 'Propor faixas com IA' }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar e propor' });
  await expect(confirm).toBeEnabled();
  const release = await holdSaves(page, media.id);
  await shortenFirst(page);
  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(confirm).toBeDisabled();
  release();
  await expect(
    page.getByRole('heading', { name: '3 faixas aplicadas.' }),
  ).toBeVisible();
  expect(sent).toEqual({ approvals: 1, runs: 0 });
  await owner.dispose();
});

test('F-2: "Aprovar faixas" waits for a paid run on hold', async ({ page }) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await stubProposals(page, media.id);
  const sent = pressesSent(page, media.id);
  await open(page, media.id);
  await page.getByRole('button', { name: 'Propor faixas com IA' }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar e propor' });
  await expect(confirm).toBeEnabled();
  const release = await holdSaves(page, media.id);
  await shortenFirst(page);
  await confirm.click();
  const approveNow = page.getByRole('button', { name: 'Aprovar faixas' });
  await expect(approveNow).toBeDisabled();
  release();
  await expect(approveNow).toBeEnabled();
  expect(sent).toEqual({ approvals: 0, runs: 1 });
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

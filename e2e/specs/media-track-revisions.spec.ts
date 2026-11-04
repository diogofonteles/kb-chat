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
import { audioState, useTheme } from './media-helpers.js';
import { approve, audioWithTracks } from './tracks-helpers.js';

// KBC-073: a track changes after its approval, cut for real by the E2E's media worker.

interface View {
  readonly version: number;
  readonly cut: string;
  readonly endMs: number;
  readonly topic: string;
}

async function publishedIn(owner: APIRequestContext, mediaId: string) {
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

interface LibraryRow {
  readonly id: string;
  readonly title: string;
  readonly tracks: readonly { readonly id: string; readonly title: string }[];
}

async function approvedTracks(owner: APIRequestContext) {
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await publishedIn(owner, media.id);
  const library = await owner.get(
    `/api/v1/media/library?q=${encodeURIComponent(media.title)}`,
  );
  const { items } = (await library.json()) as {
    readonly items: readonly LibraryRow[];
  };
  const row = items.find((one) => one.id === media.id);
  const [first, second] = row?.tracks ?? [];
  if (!first || !second) throw new Error('no tracks');
  return { media, first, second };
}

const trackPage = (id: string) => `/midia/${id}`;

async function viewOf(owner: APIRequestContext, id: string): Promise<View> {
  const read = await owner.get(`/api/v1/media/${id}/track-edit`);
  return (await read.json()) as View;
}

async function waitForCut(owner: APIRequestContext, id: string) {
  await expect
    .poll(async () => (await viewOf(owner, id)).cut, { timeout: 30_000 })
    .toBe('none');
}

const editDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Editar faixa' });

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const overlap = (one: Box, other: Box) =>
  one.x < other.x + other.width &&
  other.x < one.x + one.width &&
  one.y < other.y + other.height &&
  other.y < one.y + one.height;

async function expectInsideTheScreen(page: Page) {
  const menu = await page.getByRole('menu').boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(menu?.x).toBeGreaterThanOrEqual(0);
  expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(width);
}

test('AC-1, AC-12: the title changes on the same page and the history says so', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  await page.goto(trackPage(first.id));

  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const dialog = editDialog(page);
  await dialog
    .getByRole('textbox', { name: 'Título' })
    .fill('Título corrigido');
  await dialog.getByRole('button', { name: 'Salvar' }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Título corrigido' }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(first.id));
  await page.locator('summary', { hasText: 'Histórico' }).click();
  await expect(
    page.getByText(/Primeira pergunta → Título corrigido/),
  ).toBeVisible();
  await owner.dispose();
});

test('AC-13: who saves second sees the other title and keeps theirs', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  await page.goto(trackPage(first.id));
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const dialog = editDialog(page);
  await dialog.getByRole('textbox', { name: 'Título' }).fill('O meu título');

  const { version } = await viewOf(owner, first.id);
  const other = await owner.patch(`/api/v1/media/${first.id}`, {
    headers: { ...CSRF, 'if-match': `"${version}"` },
    data: { title: 'O título dela' },
  });
  expect(other.status()).toBe(200);
  await dialog.getByRole('button', { name: 'Salvar' }).click();

  await expect(dialog.getByRole('alert')).toContainText(
    'Título dela: O título dela',
  );
  await expect(dialog.getByRole('textbox', { name: 'Título' })).toHaveValue(
    'O meu título',
  );
  await dialog.getByRole('button', { name: 'Salvar o meu por cima' }).click();
  await expect(
    page.getByRole('heading', { name: 'O meu título' }),
  ).toBeVisible();
  await owner.dispose();
});

test('AC-4, AC-5, AC-6: the bounds move, with the track in the bar limited by its neighbour, and who listens goes on', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  await page.goto(trackPage(first.id));
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.2);
  const playingFrom = (await audioState(page)).src;

  const { version } = await viewOf(owner, first.id);
  const moved = await owner.put(`/api/v1/media/${first.id}/bounds`, {
    headers: { ...CSRF, 'if-match': `"${version}"` },
    data: { startMs: 2_000, endMs: 12_000 },
  });
  expect(moved.status()).toBe(202);
  await waitForCut(owner, first.id);

  // AC-5: the same file goes on, and a jump inside it still answers.
  expect((await audioState(page)).src).toBe(playingFrom);
  expect((await audioState(page)).paused).toBe(false);
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();
  const old = await owner.get(
    new URL(playingFrom).pathname + new URL(playingFrom).search,
  );
  expect(old.status()).toBe(200);

  await page.goto(trackPage(first.id));
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).duration)
    .toBeGreaterThan(9.5);
  expect((await audioState(page)).duration).toBeLessThan(10.5);
  expect((await audioState(page)).src).not.toBe(playingFrom);
  await owner.dispose();
});

test("BR-3, BR-4: a position saved on the old cut is translated by the browser's own save", async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  await page.goto(trackPage(first.id));
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(4);

  const { version } = await viewOf(owner, first.id);
  const moved = await owner.put(`/api/v1/media/${first.id}/bounds`, {
    headers: { ...CSRF, 'if-match': `"${version}"` },
    data: { startMs: 3_000, endMs: 13_000 },
  });
  expect(moved.status()).toBe(202);
  await waitForCut(owner, first.id);

  const saved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && request.url().endsWith('/progress'),
  );
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();
  const sent = (await saved).postDataJSON() as {
    readonly positionMs: number;
    readonly fileVersion: number;
  };

  expect(sent.fileVersion).toBe(1);
  await expect
    .poll(async () => {
      const item = await owner.get(`/api/v1/media/${first.id}`);
      return ((await item.json()) as { positionMs: number }).positionMs;
    })
    .toBe(sent.positionMs - 3_000);
  await owner.dispose();
});

test("BR-10: the editor of bounds keeps the adjustment against another person's change", async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  await page.goto(`${trackPage(first.id)}/limites`);
  const times = page.getByRole('paragraph').filter({ hasText: /^Início/ });
  const before = await times.textContent();
  await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
  await expect(times).toContainText('0:00,5');
  const adjusted = await times.textContent();
  expect(adjusted).not.toBe(before);

  const { version } = await viewOf(owner, first.id);
  const other = await owner.patch(`/api/v1/media/${first.id}`, {
    headers: { ...CSRF, 'if-match': `"${version}"` },
    data: { title: 'O título dela' },
  });
  expect(other.status()).toBe(200);
  await page.getByRole('button', { name: 'Salvar limites' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Outra pessoa mudou esta faixa');
  await expect(alert).toContainText('Título dela: O título dela');
  await expect(times).toHaveText(adjusted ?? '');
  await page.getByRole('button', { name: 'Salvar o meu por cima' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Pronto' }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(alert).toHaveCount(0);
  await expect(times).toHaveText(adjusted ?? '');
  await owner.dispose();
});

test('BR-10: while her cut runs the editor shows her bounds, and the choice opens when it lands', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  const editor = `**/api/v1/media/${first.id}/track-edit`;
  await page.goto(`${trackPage(first.id)}/limites`);
  const times = page.getByRole('paragraph').filter({ hasText: /^Início/ });
  await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
  await expect(times).toContainText('0:00,5');
  const adjusted = await times.textContent();

  const { version, endMs } = await viewOf(owner, first.id);
  const hers = await owner.put(`/api/v1/media/${first.id}/bounds`, {
    headers: { ...CSRF, 'if-match': `"${version}"` },
    data: { startMs: 2_000, endMs },
  });
  expect(hers.status()).toBe(202);
  // The worker cuts faster than a person clicks: the window is held open at the route.
  await page.route(`**/api/v1/media/${first.id}/bounds`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'A cut of this track is on its way',
          details: { reason: 'cut-running' },
        },
      },
    }),
  );
  await page.route(editor, async (route) => {
    const answer = await route.fetch();
    await route.fulfill({
      response: answer,
      json: { ...(await answer.json()), cut: 'running' },
    });
  });
  await page.getByRole('button', { name: 'Salvar limites' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Outra pessoa mudou esta faixa');
  await expect(alert).toContainText('Limites dela: Início 0:02,0');
  await expect(times).toHaveText(adjusted ?? '');
  const saveMine = page.getByRole('button', { name: 'Salvar o meu por cima' });
  await expect(saveMine).toBeDisabled();

  await waitForCut(owner, first.id);
  await page.unrouteAll({ behavior: 'wait' });

  await expect(saveMine).toBeEnabled({ timeout: 10_000 });
  await saveMine.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Pronto' }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(times).toHaveText(adjusted ?? '');
  await owner.dispose();
});

test('FR-6: a cut that failed says so on the editor of bounds, and tries again', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  let failed = true;
  // A real failure needs the worker's disk: the state on screen is what this asks of it.
  await page.route(`**/api/v1/media/${first.id}/track-edit`, async (route) => {
    const read = await route.fetch();
    const body = (await read.json()) as View;
    await route.fulfill({
      response: read,
      json: failed ? { ...body, cut: 'failed' } : body,
    });
  });
  await page.route(
    `**/api/v1/media/${first.id}/bounds/retry`,
    async (route) => {
      failed = false;
      const read = await owner.get(`/api/v1/media/${first.id}/track-edit`);
      await route.fulfill({ status: 202, json: await read.json() });
    },
  );
  await page.goto(`${trackPage(first.id)}/limites`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Não foi possível recortar.');

  await alert.getByRole('button', { name: 'Tentar de novo' }).click();

  await expect(alert).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Pronto' }),
  ).toBeVisible();
  await owner.dispose();
});

test('FR-6, AC-6: the editor of one track saves with the keyboard and stops at the neighbour', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  await page.goto(trackPage(first.id));
  await page.getByRole('link', { name: 'Ajustar início e fim' }).click();
  const end = page.getByRole('slider', { name: /Fim da faixa 1/ });
  await end.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByText('Encostou na faixa 2')).toBeVisible();

  const start = page.getByRole('slider', { name: /Início da faixa 1/ });
  await start.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await page.getByRole('button', { name: 'Salvar limites' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Pronto' }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await owner.dispose();
});

test('AC-8: deleting says the impact, the track leaves the library, and it comes back', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { media, first } = await approvedTracks(owner);
  await page.goto(trackPage(first.id));

  await page.getByRole('button', { name: 'Apagar faixa' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('restaurar em até 30 dias');
  await dialog.getByRole('button', { name: 'Apagar faixa' }).click();

  await expect(page.getByText('Faixa removida da edição')).toBeVisible();
  await page.goto(`/midia/${media.id}`);
  await page.getByRole('heading', { name: 'Faixas apagadas' }).waitFor();
  await page.getByRole('button', { name: 'Restaurar' }).click();
  await expect(
    page.getByRole('heading', { name: 'Faixas apagadas' }),
  ).toBeHidden();

  await page.goto(trackPage(first.id));
  await expect(page.getByText('Faixa removida da edição')).toBeHidden();
  await expect(page.getByText('faixa 1 de 3')).toBeVisible();
  await owner.dispose();
});

test('AC-11: the suggestion shows its cost, and nothing changes until "Usar" and "Salvar"', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  const { topic } = await viewOf(owner, first.id);
  const speaker = await owner.post(`/api/v1/topics/${topic}/speakers`, {
    headers: CSRF,
    data: { name: `Quem perguntou ${Date.now()}` },
  });
  expect(speaker.status(), await speaker.text()).toBe(201);
  const asker = (await speaker.json()) as {
    readonly id: string;
    readonly name: string;
  };
  // The E2E server cannot script its fake model: the route answers here (as KBC-069's spec).
  await page.route(`**/api/v1/media/${first.id}/suggestions`, async (route) => {
    const { dryRun } = route.request().postDataJSON() as { dryRun: boolean };
    await route.fulfill(
      dryRun
        ? {
            status: 200,
            json: {
              estimateUsd: 0.0012,
              runCapUsd: 1,
              windows: 1,
              model: 'stub',
              allowed: true,
              refusal: null,
              month: null,
            },
          }
        : {
            status: 201,
            json: {
              title: 'Título da IA',
              summary: null,
              askerSpeakerId: asker.id,
              answererSpeakerId: null,
              subjects: [],
              spentUsd: 0.001,
            },
          },
    );
  });
  await page.goto(trackPage(first.id));
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const dialog = editDialog(page);
  await dialog.getByRole('button', { name: 'Ver quanto custa' }).click();
  await expect(dialog).toContainText('0,0012');
  await dialog.getByRole('button', { name: 'Confirmar e sugerir' }).click();
  await expect(dialog.getByText('Título da IA')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Título' })).toHaveValue(
    first.title,
  );

  await dialog
    .getByRole('button', { name: 'Usar a sugestão Título da IA' })
    .click();

  await expect(dialog.getByRole('textbox', { name: 'Título' })).toHaveValue(
    'Título da IA',
  );
  await dialog
    .getByRole('button', {
      name: `Usar a sugestão Quem pergunta: ${asker.name}`,
    })
    .click();
  await expect(
    dialog.getByRole('combobox', { name: 'Quem pergunta' }),
  ).toHaveValue(asker.name);
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('heading', { name: first.title })).toBeVisible();
  await owner.dispose();
});

test("the library's ⋯ opens the page on the action chosen", async ({
  page,
}) => {
  const owner = await ownerApi();
  const { media, first } = await approvedTracks(owner);
  await page.goto('/biblioteca');
  await page.getByRole('searchbox').fill(media.title);
  await expect(page.getByText(/^1 mídia/)).toBeVisible();

  await page.getByRole('button', { name: `Ações de ${first.title}` }).click();
  await expectInsideTheScreen(page);
  await page.getByRole('menuitem', { name: 'Editar' }).click();

  await expect(editDialog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/midia/${first.id}$`));
  await owner.dispose();
});

test("the ⋯ of a track in the library's grid stays on its card", async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const { media, first } = await approvedTracks(owner);
  // The view is remembered per person: the owner's list stays as the other tests need it.
  const email = uniqueEmail('grade-editor');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-library', 'media-tracks', 'media-edit'],
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto('/biblioteca');
  await page.getByRole('searchbox').fill(media.title);
  await expect(page.getByText(/^1 mídia/)).toBeVisible();
  const grid = page.getByRole('button', { name: 'Ver em grade' });
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'true');

  // On the title's line: below it there is a blank line, beside the time it covers the time.
  const actions = page.getByRole('button', { name: `Ações de ${first.title}` });
  const title = page.getByRole('link', { name: first.title });
  const time = page
    .getByRole('listitem')
    .filter({ has: actions })
    .last()
    .getByText('0:15');
  await expect
    .poll(async () => {
      const [menu, name, length] = [
        await actions.boundingBox(),
        await title.boundingBox(),
        await time.boundingBox(),
      ];
      if (!menu || !name || !length) return null;
      return (
        menu.y < name.y + name.height &&
        !overlap(menu, name) &&
        !overlap(menu, length)
      );
    })
    .toBe(true);
  await actions.click();
  await expectInsideTheScreen(page);
});

test('AC-14: a listener sees none of it', async ({ browser, viewport }) => {
  const owner = await ownerApi();
  const { first } = await approvedTracks(owner);
  const email = uniqueEmail('ouvinte');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-tracks'],
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);

  await page.goto(trackPage(first.id));

  await expect(page.getByRole('heading', { name: first.title })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Editar', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('link', { name: 'Ajustar início e fim' }),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: 'Apagar faixa' })).toBeHidden();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-15: the track page, the dialog and the editor pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    const owner = await ownerApi();
    const { first } = await approvedTracks(owner);
    await useTheme(page, theme);
    await page.goto(trackPage(first.id));
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await expect(editDialog(page)).toBeVisible();
    const dialog = await new AxeBuilder({ page })
      .include('dialog')
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(
      dialog.violations.filter(({ impact }) => impact !== 'minor'),
    ).toEqual([]);

    await page.goto(`${trackPage(first.id)}/limites`);
    await expect(page.getByRole('slider').first()).toBeVisible();
    const editor = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(
      editor.violations.filter(({ impact }) => impact !== 'minor'),
    ).toEqual([]);
    await owner.dispose();
  });
}

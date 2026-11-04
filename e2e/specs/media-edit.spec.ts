import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { uniqueTag, uploadReady, useTheme } from './media-helpers.js';

/** KBC-050: "Editar informações" in the list (T14), the library (T16) and the page (T15). */

const UPLOADER = ['search', 'media', 'media-upload'] as const;
const SEEN = ['hermetismo', 'alquimia'];
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const viewport = () => test.info().project.use.viewport ?? null;

async function personPage(
  browser: Browser,
  features: readonly string[] = UPLOADER,
): Promise<Page> {
  const owner = await ownerApi();
  const email = uniqueEmail('edita');
  await invite(owner, email, { topics: SEEN, features: [...features] });
  await owner.dispose();
  return pageAs(browser, email, viewport());
}

async function openMedia(page: Page) {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await expect(
    page.getByRole('heading', { name: /Mídia — Hermetismo/ }),
  ).toBeVisible();
}

/** A person with an audio they sent, on the collection's list. */
async function withAudio(browser: Browser) {
  const page = await personPage(browser);
  const title = `Palestra ${uniqueTag()}`;
  const { id } = await uploadReady(page.request, { title, seconds: 2 });
  await openMedia(page);
  return { page, id, title };
}

const menuOf = (page: Page, title: string) =>
  page.getByRole('button', { name: `Mais ações para ${title}` });

async function openDialog(page: Page, title: string) {
  await menuOf(page, title).click();
  await page.getByRole('menuitem', { name: 'Editar informações' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Editar informações' }),
  ).toBeVisible();
}

const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

test('AC-1: who sent it renames it; the list and the page show it, and it plays', async ({
  browser,
}) => {
  const { page, id, title } = await withAudio(browser);
  await openDialog(page, title);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Título')).toHaveValue(title);
  const renamed = `A conselheira do rei ${uniqueTag()}`;
  await dialog.getByLabel('Título').fill(renamed);
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: renamed })).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeHidden();
  await expect(page.getByText('Informações salvas')).toBeAttached();
  await page.goto(`/midia/${id}`);
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
});

test('T15: the page edits too, and the mini-player follows the title while it plays', async ({
  browser,
}) => {
  const { page, id } = await withAudio(browser);
  await page.goto(`/midia/${id}`);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await page.getByRole('button', { name: 'Editar informações' }).click();
  const renamed = `Novo ${uniqueTag()}`;
  await page.getByLabel('Título').fill(renamed);
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(renamed));
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Editar informações' }),
  ).toBeFocused();
});

test('AC-2: moved, it leaves the list with the notice and the link, and keeps the position', async ({
  browser,
}) => {
  const { page, id, title } = await withAudio(browser);
  const saved = await page.request.put(`/api/v1/media/${id}/progress`, {
    data: { positionMs: 1_000, basedOn: null },
    headers: CSRF,
  });
  expect(saved.status()).toBe(200);
  await openDialog(page, title);
  await page.getByLabel('Acervo').selectOption('alquimia');
  await expect(page.getByText(/Quem não vê este acervo/)).toBeVisible();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText(`${title} foi movido para o acervo Alquimia.`).first(),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeHidden();
  await page.getByRole('link', { name: 'Ver o acervo' }).click();
  await expect(
    page.getByRole('heading', { name: /Mídia — Alquimia/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  const read = await page.request.get(`/api/v1/media/${id}`);
  expect(await read.json()).toMatchObject({
    topic: 'alquimia',
    positionMs: 1_000,
  });
});

test('AC-3: whoever did not send it sees no "Editar informações"', async ({
  browser,
}) => {
  const { page: sender, id, title } = await withAudio(browser);
  await sender.context().close();
  const other = await personPage(browser);
  await openMedia(other);
  await expect(other.getByRole('link', { name: title })).toBeVisible();
  await expect(menuOf(other, title)).toBeHidden();
  await other.goto(`/midia/${id}`);
  await expect(other.getByRole('heading', { name: title })).toBeVisible();
  await expect(
    other.getByRole('button', { name: 'Editar informações' }),
  ).toBeHidden();
});

test('AC-5, FR-4: a blank title is said at the field; a server error keeps what was typed', async ({
  browser,
}) => {
  const { page, title } = await withAudio(browser);
  await openDialog(page, title);
  const field = page.getByLabel('Título');
  await field.fill('   ');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Dê um título ao áudio.')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.fill('Título que fica');
  await page.route('**/api/v1/media/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 403,
          json: { error: { code: 'FORBIDDEN', message: 'no' } },
        })
      : route.fallback(),
  );
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('alert')).toContainText('permissão');
  await expect(field).toHaveValue('Título que fica');
});

test('AC-7: works by keyboard, and Escape gives the focus back to the menu', async ({
  browser,
}) => {
  const { page, title } = await withAudio(browser);
  const trigger = menuOf(page, title);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Editar informações' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Editar informações' });
  await expect(dialog.getByLabel('Título')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-7: no serious axe violation in the dialog, theme ${theme}`, async ({
    browser,
  }) => {
    const page = await personPage(browser);
    await useTheme(page, theme);
    const title = `Palestra ${uniqueTag()}`;
    await uploadReady(page.request, { title, seconds: 1 });
    await openMedia(page);
    await openDialog(page, title);
    await page.getByLabel('Acervo').selectOption('alquimia');
    await page.getByLabel('Título').fill('');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Dê um título ao áudio.')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('T16: the library edits in its rows; the row keeps its place', async ({
  browser,
}) => {
  const page = await personPage(browser, [...UPLOADER, 'media-library']);
  const title = `Palestra ${uniqueTag()}`;
  await uploadReady(page.request, { title, seconds: 1 });
  await page.goto('/biblioteca');
  await openDialog(page, title);
  const renamed = `Na biblioteca ${uniqueTag()}`;
  await page.getByLabel('Título').fill(renamed);
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('link', { name: renamed })).toBeVisible();
  await expect(menuOf(page, renamed)).toBeVisible();
  await openDialog(page, renamed);
  await page.getByLabel('Acervo').selectOption('alquimia');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText(`${renamed} foi movido para o acervo Alquimia.`).first(),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Ver o acervo' }).click();
  await expect(page).toHaveURL(/acervo=alquimia/);
  await expect(page.getByRole('link', { name: renamed })).toBeVisible();
});

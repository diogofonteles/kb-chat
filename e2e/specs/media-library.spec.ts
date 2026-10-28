import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { makeMp3, uploadReady, useTheme } from './media-helpers.js';

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** "Mídia" in the sidebar, or in the phone's menu (T14). */
async function openMedia(page: Page) {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await expect(
    page.getByRole('heading', { name: /Mídia — Hermetismo/ }),
  ).toBeVisible();
}

const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

test('AC-1: a master uploads an MP3, sees it go to "Pronta" and opens it', async ({
  page,
}) => {
  const title = `Palestra ${Date.now().toString(36)}`;
  const file = makeMp3(title.replace(/\s+/g, '_'), 8);
  await openMedia(page);
  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
  await expect(
    dialog.getByText('mp3, m4a, wav, flac, ogg ou opus, até 500 MB'),
  ).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByRole('textbox', { name: 'Título' })).toHaveValue(
    title,
  );
  await dialog.getByRole('radio', { name: /Outros autores/ }).check();
  await dialog.getByRole('button', { name: 'Enviar' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText('Pronta')).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('0:08')).toBeVisible();
  await row.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Posição' })).toBeVisible();
});

test('AC-8: a file that is not audio is refused before sending', async ({
  page,
}) => {
  await openMedia(page);
  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'apostila.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });
  await expect(dialog.getByRole('alert')).toContainText(
    'Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus.',
  );
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
});

test('AC-4: "Ouvir mídia" without "Enviar áudios" shows the list but no upload', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('ouvinte');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'media'],
  });
  const page = await pageAs(
    browser,
    email,
    test.info().project.use.viewport ?? null,
  );
  await openMedia(page);
  await expect(page.getByRole('button', { name: 'Enviar áudio' })).toHaveCount(
    0,
  );
  const refused = await page.request.post('/api/v1/topics/hermetismo/media', {
    data: {
      title: 'x',
      authorship: 'outros-autores',
      fileName: 'x.mp3',
      bytes: 3,
    },
    headers: CSRF,
  });
  expect(refused.status()).toBe(403);
  await page.context().close();
});

test('BR-2: without "Ouvir mídia" there is no Mídia, and /midia goes home', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('sem-midia');
  await invite(owner, email, { topics: ['hermetismo'], features: ['search'] });
  const page = await pageAs(
    browser,
    email,
    test.info().project.use.viewport ?? null,
  );
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('link', { name: 'Mídia' })).toHaveCount(0);
  await page.goto('/midia');
  await expect(page).toHaveURL(/\/$/);
  expect(
    (await page.request.get('/api/v1/topics/hermetismo/media')).status(),
  ).toBe(403);
  await page.context().close();
});

test('AC-13: a master removes an item after confirming, and its audio is gone', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await uploadReady(owner, {
    title: `Remover ${Date.now().toString(36)}`,
    seconds: 2,
  });
  await openMedia(page);
  await page
    .getByRole('button', { name: `Mais ações para ${media.title}` })
    .click();
  await page.getByRole('menuitem', { name: 'Remover' }).click();
  const confirm = page.getByRole('dialog', {
    name: `Remover "${media.title}"?`,
  });
  await expect(confirm).toContainText('não podem ser recuperados');
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  await expect(
    page.getByRole('listitem').filter({ hasText: media.title }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: `Mais ações para ${media.title}` })
    .click();
  await page.getByRole('menuitem', { name: 'Remover' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remover' })
    .click();
  await expect(
    page.getByRole('listitem').filter({ hasText: media.title }),
  ).toHaveCount(0);
  expect((await owner.get(`/api/v1/media/${media.id}/stream`)).status()).toBe(
    404,
  );
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-9: the list and the upload panel pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    const owner = await ownerApi();
    await uploadReady(owner, { title: `Acessível ${theme}`, seconds: 1 });
    await useTheme(page, theme);
    await openMedia(page);
    await expect(page.getByText('Pronta').first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
    await expect(
      page.getByRole('dialog', { name: 'Enviar áudio' }),
    ).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

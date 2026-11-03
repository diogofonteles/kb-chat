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
import { uniqueTag, uploadReady, useTheme } from './media-helpers.js';

// KBC-036: the transcription status of the media and the masters' "Transcritores".

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openSettings(page: Page) {
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openMedia(page: Page) {
  await page.goto('/');
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await expect(
    page.getByRole('heading', { name: /Mídia — Hermetismo/ }),
  ).toBeVisible();
}

const seriousViolations = async (page: Page, include?: string) => {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  return (await builder.analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
};

/**
 * Every transcriber was last seen 2 h ago (an E2E-only route). The specs never call the
 * worker routes with a transcriber's token, so no test turns one "on" under another.
 */
async function transcribersOffForTwoHours(): Promise<void> {
  const owner = await ownerApi();
  const paired = await owner.post('/api/v1/media/transcribers', {
    data: { name: `Mac desligado ${uniqueTag()}` },
    headers: CSRF,
  });
  expect(paired.status(), await paired.text()).toBe(201);
  const aged = await owner.post('/api/e2e/transcribers/last-seen', {
    data: { hoursAgo: 2 },
    headers: CSRF,
  });
  expect(aged.status()).toBe(204);
  await owner.dispose();
}

test('AC-2: with no transcriber seen for 2 h, a ready audio waits and says since when it is off', async ({
  page,
}) => {
  await transcribersOffForTwoHours();
  const owner = await ownerApi();
  const { title } = await uploadReady(owner, {
    title: `Aguardando ${uniqueTag()}`,
    seconds: 3,
  });
  await owner.dispose();
  await openMedia(page);
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText(
    /Aguardando o transcritor · desligado desde \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/,
  );
  await row.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('app-media-player-page .meta')).toContainText(
    /Aguardando o transcritor · desligado desde/,
  );
});

test('AC-7: a member sees no "Transcritores" and the API refuses them', async ({
  browser,
  viewport,
}) => {
  const email = uniqueEmail('membro-transcritores');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'media', 'media-upload'],
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('button', { name: 'Sobre' })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Transcritores' }),
  ).toHaveCount(0);
  const listed = await page.request.get('/api/v1/media/transcribers');
  expect(listed.status()).toBe(403);
  const paired = await page.request.post('/api/v1/media/transcribers', {
    data: { name: 'Meu Mac' },
    headers: CSRF,
  });
  expect(paired.status()).toBe(403);
  await page.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-10, FR-5: a master pairs and revokes a transcriber, and the screens pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    await transcribersOffForTwoHours();
    await openMedia(page);
    // The status of the media list (T14) in this theme.
    expect(await seriousViolations(page, 'app-media-list-page')).toEqual([]);

    const name = `Mac ${theme} ${uniqueTag()}`;
    const dialog = await openSettings(page);
    await dialog.getByRole('button', { name: 'Transcritores' }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Transcritores', level: 3 }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Parear transcritor' }).click();
    await expect(dialog.getByText('Dê um nome ao transcritor.')).toBeVisible();
    await dialog.getByLabel('Nome do transcritor').fill(name);
    await dialog.getByRole('button', { name: 'Parear transcritor' }).click();
    const box = dialog.getByRole('region', { name: `"${name}" pareado` });
    await expect(box).toBeFocused();
    await expect(box.locator('code.token')).toHaveText(/^nat_[\w-]{40,}$/);
    await expect(box).toContainText(
      'uv run --project tools/transcriber transcriber pair --api-url http://localhost',
    );
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await seriousViolations(page, 'dialog')).toEqual([]);
    await box.getByRole('button', { name: 'Pronto, já copiei' }).click();
    await expect(box).toHaveCount(0);

    const item = dialog.getByRole('listitem').filter({ hasText: name });
    await expect(item).toContainText('Desligado');
    await expect(item).toContainText('ainda não foi visto');
    await item.getByRole('button', { name: `Revogar ${name}` }).click();
    await expect(item).toContainText(`Revogar "${name}"?`);
    expect(await seriousViolations(page, 'dialog')).toEqual([]);
    await item.getByRole('button', { name: 'Revogar', exact: true }).click();
    await expect(
      dialog.getByRole('listitem').filter({ hasText: name }),
    ).toHaveCount(0);
  });
}

test('AC-10: "Transcritores" works by keyboard, and the focus never falls to the page (WCAG 2.4.3)', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Transcritores' }).click();
  const name = `Mac teclado ${uniqueTag()}`;
  const field = dialog.getByLabel('Nome do transcritor');
  await field.focus();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  const box = dialog.getByRole('region', { name: `"${name}" pareado` });
  await expect(box).toBeFocused();
  const done = box.getByRole('button', { name: 'Pronto, já copiei' });
  await done.focus();
  await page.keyboard.press('Enter');
  await expect(field).toBeFocused();

  const item = dialog.getByRole('listitem').filter({ hasText: name });
  const revoke = item.getByRole('button', { name: `Revogar ${name}` });
  await revoke.focus();
  await page.keyboard.press('Enter');
  const cancel = item.getByRole('button', { name: 'Cancelar' });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(revoke).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const confirm = item.getByRole('button', { name: 'Revogar', exact: true });
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Pareados' })).toBeFocused();
  await expect(dialog.getByRole('status')).toContainText(`"${name}" revogado.`);
  await expect(
    dialog.getByRole('listitem').filter({ hasText: name }),
  ).toHaveCount(0);
});

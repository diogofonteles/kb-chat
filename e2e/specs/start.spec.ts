import { expect, test } from '@playwright/test';
import { startInSearchView } from './search-view.js';

test.beforeEach(startInSearchView);

test('AC-1/AC-2: start suggestions list the largest subjects and search one with its filter', async ({
  page,
}) => {
  await page.goto('/');
  const group = page.getByRole('group', { name: 'Comece por um assunto:' });
  const buttons = group.getByRole('button');
  await expect(buttons.first()).toBeVisible();
  expect(await buttons.count()).toBeLessThanOrEqual(6);
  const counts = (await buttons.allTextContents()).map((text) =>
    Number(text.replace(/\D/g, '')),
  );
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
  const name = (await buttons.first().textContent())
    ?.replace(/[\d.]/g, '')
    .trim();
  await buttons.first().click();
  await expect(page.locator('app-result-message .question')).toContainText(
    name ?? '',
  );
  await expect(
    page.getByRole('button', { name: `Remover Assuntos: ${name}` }),
  ).toBeVisible();
});

test('AC-4: a failing usage log never shows an error', async ({ page }) => {
  await page.route('**/api/v1/events', (route) =>
    route.fulfill({ status: 500, body: '{}' }),
  );
  await page.goto('/');
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
  // The search itself shows no error (other alerts, such as the AI estimate's rate limit when
  // the whole suite runs in parallel, are unrelated to the usage log).
  await expect(page.locator('app-result-message .answer.error')).toHaveCount(0);
});

for (const size of [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
]) {
  test(`the start screen shows the whole greeting below the top bar at ${size.width}×${size.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'laptop heights only');
    await page.setViewportSize(size);
    await page.goto('/');
    for (const view of ['Pesquisa com IA', 'Buscar documentos']) {
      await page.getByRole('radio', { name: new RegExp(view) }).check();
      const greeting = page.locator('.greeting');
      await expect(greeting).toBeVisible();
      const top = await page.locator('.topbar').boundingBox();
      const title = await greeting.boundingBox();
      expect(title?.y ?? 0).toBeGreaterThanOrEqual(
        (top?.y ?? 0) + (top?.height ?? 0),
      );
      await expect(greeting).toBeInViewport({ ratio: 1 });
    }
  });
}

test('the top bar stays on one line with the document panel open', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'the side panel is desktop only',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const height = async () =>
    (await page.locator('.topbar').boundingBox())?.height ?? 0;
  const closed = await height();
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.locator('[data-doc-id]').first().click();
  await expect(page.locator('app-document-panel')).toBeVisible();
  expect(await height()).toBeLessThanOrEqual(closed + 1);
});

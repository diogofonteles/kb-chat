import { expect, test } from '@playwright/test';

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

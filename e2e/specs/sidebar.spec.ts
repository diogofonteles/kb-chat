import { expect, test, type Page } from '@playwright/test';

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** On phones the side panel lives in the "Menu" drawer (KBC-005 FR-6). */
async function sidebar(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
}

async function ask(page: Page, question: string) {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('AC-1/AC-2: a new conversation clears the screen and the history brings the old one back', async ({
  page,
}) => {
  await ask(page, 'ritmo');
  await (
    await sidebar(page)
  )
    .getByRole('button', { name: /Nova conversa/ })
    .click();
  await expect(page.getByText('O que você quer estudar hoje?')).toBeVisible();
  await expect(page.getByLabel('Sua pergunta')).toBeFocused();
  await ask(page, 'natureza');
  const panel = await sidebar(page);
  const history = panel.getByRole('navigation', { name: /Histórico/ });
  await expect(history.getByRole('button')).toHaveCount(2);
  await history.getByRole('button', { name: /ritmo/ }).click();
  // The restored conversation runs its search again; the other one is gone from the screen.
  await expect(page.locator('app-result-message .question')).toHaveText([
    /ritmo/,
  ]);
  await expect(page.locator('app-result-card').first()).toBeVisible();
});

test('AC-5: another collection starts a new conversation and updates the count', async ({
  page,
}) => {
  await ask(page, 'ritmo');
  const before = await page.getByRole('heading', { level: 1 }).textContent();
  const panel = await sidebar(page);
  const select = panel.getByLabel('Acervo');
  const other = await select
    .locator('option:not(:checked)')
    .first()
    .getAttribute('value');
  await select.selectOption(other ?? '');
  await expect(page.getByRole('status').first()).toContainText(
    'Nova conversa em',
  );
  await expect(page.locator('app-result-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(
    before ?? '',
  );
});

test('AC-6: the esoteric theme survives a reload', async ({ page }) => {
  await (await sidebar(page)).getByLabel('Tema').selectOption('esoteric');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'esoteric');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'esoteric');
});

test('AC-8: shows today’s AI spend against the cap', async ({ page }) => {
  await expect(
    (await sidebar(page)).getByText(/US\$\s0,03 de US\$\s1,00/),
  ).toBeVisible();
});

test('AC-9: on a phone the Menu drawer closes with Escape and focus returns to the button', async ({
  page,
}) => {
  test.skip(desktop(page), 'the drawer exists only below 1024 px');
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await drawer.getByRole('button', { name: 'Fechar menu' }).click();
  await expect(drawer).toBeHidden();
  await menu.click();
  await page.mouse.click(380, 400);
  await expect(drawer).toBeHidden();
});

import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * KBC-029: a question is in the history from the moment it is sent. The stub agent takes a
 * few seconds with "[lento]" in the question and fails with "[falha]" (stub-llm-adapter.ts).
 * Every spec writes the same owner's history, so each question is unique.
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function history(page: Page): Promise<Locator> {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  const panel = desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
  return panel.getByRole('navigation', { name: 'Histórico' });
}

async function closeMenu(page: Page) {
  if (!desktop(page)) await page.keyboard.press('Escape');
}

const unique = (text: string) =>
  `${text} ${Math.random().toString(36).slice(2, 8)}`;

const escape = (text: string) => text.replace(/[[\]().*+?^$|\\]/g, '\\$&');

const entry = (list: Locator, question: string) =>
  list.getByRole('button', { name: new RegExp(escape(question)) });

async function ask(page: Page, question: string, button = 'Perguntar') {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: button }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
});

test('AC-1: a research question shows at the top of the history at once, selected and "pesquisando…"', async ({
  page,
}) => {
  const question = unique('natureza sétupla [lento]');
  await ask(page, question);
  const list = await history(page);
  const item = entry(list, question);
  await expect(item).toContainText('pesquisando…');
  await expect(item).toHaveAttribute('aria-current', 'true');
  await expect(list.getByRole('button').first()).toContainText(question);
  const axe = await new AxeBuilder({ page }).include('app-sidebar').analyze();
  expect(
    axe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);
  await closeMenu(page);
  await expect(
    page.locator('app-research-message').getByText(/Segundo o acervo/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(entry(await history(page), question)).not.toContainText(
    'pesquisando…',
  );
});

test('AC-2: a reload during the research brings the conversation back and shows the answer when it ends', async ({
  page,
}) => {
  const question = unique('natureza sétupla [lento]');
  await ask(page, question);
  await expect(page.getByRole('button', { name: 'Parar' })).toBeVisible();
  await page.reload();
  const thread = page.locator('app-research-message');
  await expect(thread.getByText(question)).toBeVisible();
  await expect(thread.getByText(/Segundo o acervo/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Parar' })).toHaveCount(0);
});

test('AC-3: a stopped research stays in the history as "interrompida", also after a reload, with "Tentar de novo"', async ({
  page,
}) => {
  const question = unique('natureza sétupla [lento]');
  await ask(page, question);
  await page.getByRole('button', { name: 'Parar' }).click();
  await expect(entry(await history(page), question)).toContainText(
    'interrompida',
  );
  await closeMenu(page);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Tentar de novo' }),
  ).toBeVisible();
  await expect(entry(await history(page), question)).toContainText(
    'interrompida',
  );
});

test('AC-3: a failed research stays in the history as "falhou", with "Tentar de novo"', async ({
  page,
}) => {
  const question = unique('natureza sétupla [falha]');
  await ask(page, question);
  await expect(page.getByRole('alert')).toContainText(
    'Não consegui gerar a resposta agora.',
  );
  await expect(
    page.getByRole('button', { name: 'Tentar de novo' }),
  ).toBeVisible();
  await expect(entry(await history(page), question)).toContainText('falhou');
});

test('AC-1: a search question is in the history as soon as it is sent', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  const question = unique('ritmo');
  await ask(page, question, 'Buscar');
  await expect(entry(await history(page), question)).toBeVisible();
});

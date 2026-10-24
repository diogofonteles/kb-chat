import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startInSearchView } from './search-view.js';

test.beforeEach(startInSearchView);

async function openFirst(
  page: Page,
  question: string,
  title: RegExp,
): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Hermetismo',
  );
  await page
    .getByLabel('Como buscar')
    .selectOption({ label: 'Por significado' });
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: title }).first().click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { level: 2 }),
  ).toBeVisible();
}

test('AC-1/AC-2: the question terms are highlighted and the counter steps through them', async ({
  page,
}) => {
  await openFirst(page, 'natureza setupla', /A Natureza Sétupla/);
  const panel = page.getByRole('dialog');
  await expect(panel.locator('mark').first()).toBeInViewport();
  await expect(panel.getByText(/1 de \d+ ocorrências/)).toBeVisible();
  await panel.getByRole('button', { name: 'Próxima ocorrência' }).click();
  await expect(panel.getByText(/2 de \d+ ocorrências/)).toBeVisible();
});

test('AC-3/AC-6: "Veja também" opens the concept, which lists its examples, and "Voltar" returns', async ({
  page,
}) => {
  await openFirst(page, 'sephiroth', /A Árvore da Vida/);
  const panel = page.getByRole('dialog');
  await panel
    .getByRole('button', { name: 'Cabala', exact: true })
    .last()
    .click();
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Cabala');
  await expect(panel.getByRole('heading', { name: 'Exemplos' })).toBeVisible();
  await expect(panel.getByText(/Sobre este assunto/)).toBeVisible();
  await panel.getByRole('button', { name: '← Voltar' }).click();
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(
    'A Árvore da Vida',
  );
});

test('AC-7: a subject in the panel filters the conversation', async ({
  page,
}) => {
  await openFirst(page, 'natureza', /A Natureza Sétupla/);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Filtrar a conversa por Cabala' })
    .click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Remover Assuntos: Cabala' }),
  ).toBeVisible();
});

test('AC-8: an audio transcription carries its badge', async ({ page }) => {
  await openFirst(page, 'sephiroth', /A Árvore da Vida/);
  await expect(page.getByRole('dialog').locator('.badge')).toContainText(
    'Transcrição automática de áudio',
  );
});

test('NFR-1: a 200 KB document opens with its highlight in under 500 ms', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Como buscar')
    .selectOption({ label: 'Por significado' });
  await page.getByLabel('Sua pergunta').fill('quintessência');
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.getByRole('button', { name: /Tratado Longo/ });
  await expect(card).toBeVisible();
  const started = Date.now();
  await card.click();
  await expect(
    page.getByRole('dialog').locator('mark').first(),
  ).toBeInViewport();
  expect(Date.now() - started).toBeLessThan(500);
});

test('AC-9: "Copiar trecho" copies the paragraph of the current occurrence', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'clipboard permissions are Chromium-only here',
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFirst(page, 'natureza setupla', /A Natureza Sétupla/);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Copiar trecho' })
    .click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Copiado' }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /NATUREZA SÉTUPLA/,
  );
});

test('AC-10: a document without relations has no "Veja também"', async ({
  page,
}) => {
  await openFirst(page, 'pitagóricos', /A Lei do Ritmo/);
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Veja também' }),
  ).toHaveCount(0);
});

test('documents with ids longer than 100 characters open', async ({ page }) => {
  await openFirst(page, 'nome de arquivo longo', /Um Título Muito Longo/);
  await expect(page.getByRole('dialog')).toContainText(
    'Texto com nome de arquivo longo.',
  );
});

test('the occurrence tools stay on screen while stepping through a long document', async ({
  page,
}) => {
  await openFirst(page, 'respiração consciente', /Tratado Longo/);
  const panel = page.getByRole('dialog');
  const next = panel.getByRole('button', { name: 'Próxima ocorrência' });
  for (let i = 0; i < 5; i += 1) await next.click();
  await expect(panel.getByText(/^6 de \d+ ocorrências/)).toBeVisible();
  await expect(next).toBeInViewport();
  await expect(panel.locator('mark.current')).toBeInViewport();
});

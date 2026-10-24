import { expect, test } from '@playwright/test';

test('AC-1/AC-3: "Responder com IA" shows its cost, streams a cited answer and opens a source', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Como buscar')
    .selectOption({ label: 'Por significado' });
  await page.getByLabel('Sua pergunta').fill('natureza sétupla');
  await page.getByRole('button', { name: 'Buscar' }).click();
  const ai = page.locator('app-ai-answer');
  const button = ai.getByRole('button', {
    name: /Responder com IA · menos de US\$ 0,01/,
  });
  await expect(button).toBeVisible();
  await button.click();
  await expect(
    ai.getByText(/Segundo o acervo, a natureza é sétupla/),
  ).toBeVisible();
  await expect(ai.getByText(/Custo: US\$/)).toBeVisible();
  await expect(
    ai.getByText(
      'Resposta gerada por IA a partir do acervo; confira nas fontes.',
    ),
  ).toBeVisible();
  await ai.getByRole('link', { name: '[1]' }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { level: 2 }),
  ).toBeVisible();
});

test('the AI block sits above the documents', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  const aiTop = await page.locator('app-ai-answer').boundingBox();
  const firstCard = await page.locator('app-result-card').first().boundingBox();
  expect(aiTop && firstCard && aiTop.y < firstCard.y).toBe(true);
});

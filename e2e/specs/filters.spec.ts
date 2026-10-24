import { expect, test, type Page } from '@playwright/test';

async function askSemantic(page: Page, question: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Hermetismo',
  );
  await page
    .getByLabel('Como buscar')
    .selectOption({ label: 'Por significado' });
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar' }).click();
}

test.describe('desktop filters', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 1024,
    'popovers are the desktop layout',
  );

  test('AC-3/AC-8: a subject chip refines the same message and its × removes it', async ({
    page,
  }) => {
    await askSemantic(page, 'natureza');
    await expect(
      page.getByText(/3 documentos · Por significado/),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Assuntos/ }).click();
    await expect(page.getByRole('checkbox', { name: /Cabala/ })).toBeVisible();
    await page.getByRole('checkbox', { name: /Cabala/ }).check();
    await expect(
      page.getByText(/2 documentos · Por significado/),
    ).toBeVisible();
    await expect(page.locator('app-result-message')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Remover Assuntos: Cabala' })
      .click();
    await expect(
      page.getByText(/3 documentos · Por significado/),
    ).toBeVisible();
  });

  test('AC-6: copies are grouped in one card and can be opened', async ({
    page,
  }) => {
    await askSemantic(page, 'sétupla');
    await expect(
      page.getByRole('button', { name: /A Natureza Sétupla/ }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: '+1 cópia' }).click();
    await page
      .getByRole('button', { name: /a-natureza-s-tupla-5\.md/ })
      .click();
    await expect(page.getByRole('dialog')).toContainText(
      'A NATUREZA SÉTUPLA (cópia)',
    );
  });

  test('AC-4/AC-5: off-topic is hidden by default and shown when selected', async ({
    page,
  }) => {
    await askSemantic(page, 'sétupla');
    await expect(page.getByText('1 oculto (fora do tema)')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Torta de pêssego/ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: /^Ligação com o tema/ }).click();
    await page.getByRole('checkbox', { name: /Fora do tema/ }).check();
    await expect(
      page.getByRole('button', { name: /Torta de pêssego/ }),
    ).toBeVisible();
  });
});

test.describe('mobile filter sheet', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) >= 1024,
    'the sheet is the mobile layout',
  );

  test('AC-10: Cancelar keeps the filters and Aplicar applies them', async ({
    page,
  }) => {
    await askSemantic(page, 'natureza');
    await expect(page.getByText(/3 documentos ·/)).toBeVisible();
    await page.getByRole('button', { name: 'Filtros', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await sheet.getByRole('checkbox', { name: /Cabala/ }).check();
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText(/3 documentos ·/)).toBeVisible();
    await page.getByRole('button', { name: 'Filtros', exact: true }).click();
    await sheet.getByRole('checkbox', { name: /Cabala/ }).check();
    await sheet.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page.getByText(/2 documentos ·/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Filtros (1)' }),
    ).toBeVisible();
  });
});

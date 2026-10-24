import { expect, test, type Page } from '@playwright/test';
import { startInSearchView } from './search-view.js';

test.beforeEach(startInSearchView);

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

test.describe('paging and empty filters', () => {
  test('AC-9: "Mostrar mais" appends results until the end', async ({
    page,
  }) => {
    await askSemantic(page, 'ritmo');
    const summary = page.getByText(/10 de \d+ documentos ·/);
    await expect(summary).toBeVisible();
    const total = Number(
      /de (\d+) documentos/.exec((await summary.textContent()) ?? '')?.[1],
    );
    expect(total).toBeGreaterThan(10);
    await expect(page.locator('app-result-card')).toHaveCount(10);
    await page.getByRole('button', { name: 'Mostrar mais' }).click();
    await expect(page.locator('app-result-card')).toHaveCount(
      Math.min(total, 20),
    );
  });

  test('AC-11: an empty filtered result offers to remove a filter', async ({
    page,
    viewport,
  }) => {
    await askSemantic(page, 'ritmo');
    await expect(page.locator('app-result-card').first()).toBeVisible();
    // The real counts never lead to zero; this request simulates an index that changed meanwhile.
    await page.route('**/searches', async (route) => {
      const body = route.request().postDataJSON() as {
        filters: { genres: string[] };
      };
      if (body.filters.genres.length === 0) return route.continue();
      const response = await route.fetch();
      const json = await response.json();
      return route.fulfill({
        response,
        json: { ...json, items: [], total: 0, nextOffset: null },
      });
    });
    const phone = (viewport?.width ?? 0) < 1024;
    await page
      .getByRole('button', {
        name: phone ? 'Filtros' : /^Tipo de texto/,
        exact: phone,
      })
      .click();
    await page.getByRole('checkbox', { name: /Texto\/apostila/ }).check();
    if (phone) await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(
      page.getByText('Nada encontrado para "ritmo" com estes filtros.'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Remover Tipo de texto: Texto/apostila' })
      .last()
      .click();
    await expect(page.locator('app-result-card').first()).toBeVisible();
  });

  test('the results page never scrolls sideways, even with active filters', async ({
    page,
    viewport,
  }) => {
    await askSemantic(page, 'natureza');
    await expect(page.locator('app-result-card').first()).toBeVisible();
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    const phone = (viewport?.width ?? 0) < 1024;
    await page
      .getByRole('button', {
        name: phone ? 'Filtros' : /^Assuntos/,
        exact: phone,
      })
      .click();
    await page
      .getByRole('checkbox', { name: /Cosmologia Espiritual e Metafísica/ })
      .check();
    if (phone) await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(
      page.getByRole('button', { name: /Remover Assuntos/ }),
    ).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    if (phone)
      await expect(
        page.getByRole('button', { name: 'Filtros (1)' }),
      ).toBeInViewport();
  });
});

test.describe('mobile sheet focus', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) >= 1024,
    'the sheet is the mobile layout',
  );

  test('the sheet traps focus and returns it to "Filtros" on Escape', async ({
    page,
  }) => {
    await askSemantic(page, 'natureza');
    const trigger = page.getByRole('button', { name: 'Filtros', exact: true });
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expect(sheet).toBeVisible();
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    expect(
      await sheet.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

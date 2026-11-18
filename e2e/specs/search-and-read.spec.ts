import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startInSearchView, modeRadio, expectSummary } from './search-view.js';

test.beforeEach(startInSearchView);

async function ask(page: Page, question: string): Promise<void> {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar' }).click();
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Hermetismo',
  );
});

test('AC-1: a question shows the matching card in the "Tudo" mode', async ({
  page,
}) => {
  await ask(page, 'natureza sétupla');
  await expect(
    page.getByRole('button', { name: /A Natureza Sétupla/ }),
  ).toBeVisible();
  await expectSummary(page, /documentos/, 'Tudo');
  if ((page.viewportSize()?.width ?? 1440) >= 1024)
    await expect(
      page.getByText('Aula ou palestra · Intermediário · Central'),
    ).toBeVisible();
  // A phone's row (cmRow) says whose it is and its type; the rest is in the document.
  else
    await expect(
      page
        .locator('app-result-card')
        .filter({ hasText: 'A Natureza Sétupla' })
        .first()
        .getByText('· Aula ou palestra'),
    ).toBeVisible();
});

test('AC-2: the chosen mode is used and remembered after a reload', async ({
  page,
}) => {
  await (await modeRadio(page, 'Palavras exatas')).check();
  await page.reload();
  await expect(await modeRadio(page, 'Palavras exatas')).toBeChecked();
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/searches') && r.method() === 'POST',
  );
  await ask(page, 'ritmo');
  expect((await request).postDataJSON()).toMatchObject({
    q: 'ritmo',
    mode: 'exact',
  });
});

test('AC-4: a card opens the document without frontmatter and Escape closes it', async ({
  page,
}) => {
  await ask(page, 'lei do ritmo');
  await page.getByRole('button', { name: /A Lei do Ritmo/ }).click();
  const panel = page.getByRole('dialog');
  await expect(
    panel.getByRole('heading', { name: 'A Lei do Ritmo' }),
  ).toBeVisible();
  await expect(panel).toContainText('Os pitagóricos afirmavam');
  await expect(panel).not.toContainText('relevance:');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  // Focus returns to the card that opened the document (QA-03).
  await expect(
    page.getByRole('button', { name: /A Lei do Ritmo/ }),
  ).toBeFocused();
});

test('AC-5: no results offers a semantic search', async ({ page }) => {
  await (await modeRadio(page, 'Palavras exatas')).check();
  await ask(page, 'xyzzy plugh');
  await expect(
    page.getByText('Nada encontrado para "xyzzy plugh".'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Buscar por significado' }).click();
  // The results' head says the mode the search ran in (the search page has no question
  // box on desktop: its mode pill is where the mode changes).
  await expect(
    page.getByRole('button', { name: 'Modo da busca: Por significado' }),
  ).toBeVisible();
});

test('AC-6: a search failure keeps the question and retries', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/searches', async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 503,
        json: { error: { code: 'SEARCH_UNAVAILABLE', message: 'down' } },
      });
      return;
    }
    await route.continue();
  });
  await ask(page, 'ritmo');
  await expect(page.getByRole('alert')).toContainText(
    'A busca está indisponível agora',
  );
  await expect(page.getByText(/Você perguntou:\s*ritmo/)).toBeVisible();
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(
    page.getByRole('button', { name: /A Lei do Ritmo/ }),
  ).toBeVisible();
});

test('AC-11: start, results and document panel have no serious axe violations', async ({
  page,
}) => {
  await expectNoSeriousViolations(page);
  await ask(page, 'ritmo');
  await expect(
    page.getByRole('button', { name: /A Lei do Ritmo/ }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.getByRole('button', { name: /A Lei do Ritmo/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page);
});

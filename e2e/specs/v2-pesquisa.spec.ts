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

// KBC-127: the source of an AI answer beside it (460) or in the phone's reading sheet (85%),
// the document as a page, the states of an answer and the collection dialog, at 1440 and
// 390. With KBC_SHOTS=<folder> each state is captured too (v2 · Conversa, v2 · Telas-chave).

const phone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 1024;

async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env['KBC_SHOTS'];
  if (!folder) return;
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `${folder}/${name}-${width}.png` });
}

const SOURCES = [
  { n: 1, id: 'raw/articles/a-lei-do-ritmo.md', title: 'A Lei do Ritmo' },
  { n: 2, id: 'raw/articles/arvore-da-vida.md', title: 'A Árvore da Vida' },
];

type Turn = Record<string, unknown>;

function turn(
  question: string,
  extra: Turn = {},
): Turn & { readonly question: string } {
  return {
    id: crypto.randomUUID(),
    question,
    answer:
      'Segundo o acervo, o ritmo rege a natureza [1] e a vida tem dez Sephiroth [2].',
    sources: SOURCES,
    steps: 2,
    usd: 0.0071,
    billing: 'per-token',
    model: 'stub/model',
    interrupted: false,
    profile: 'fast',
    at: new Date().toISOString(),
    ...extra,
  };
}

/** A reader with research, with one saved answer of its own, on the home. */
async function readerWith(
  browser: Parameters<typeof pageAs>[0],
  viewport: { width: number; height: number } | null,
  saved: Turn & { readonly question: string },
): Promise<Page> {
  const { question } = saved;
  const owner = await ownerApi();
  const email = uniqueEmail('fonte');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research'],
  });
  const page = await pageAs(browser, email, viewport);
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const put = await page.request.put(`/api/v1/conversations/${id}`, {
    headers: CSRF,
    data: {
      kind: 'research',
      id,
      topic: 'hermetismo',
      title: question,
      createdAt: at,
      updatedAt: at,
      turns: [saved],
    },
  });
  expect(put.status(), await put.text()).toBe(200);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Recentes' })
    .getByRole('button', { name: new RegExp(question) })
    .click();
  await expect(page.locator('app-research-message .answer')).toBeVisible();
  return page;
}

test('AC-1, AC-2, NFR-4: [2] opens its source beside the answer, marked; "Fonte ‹" goes to the first', async ({
  browser,
}, testInfo) => {
  const viewport = testInfo.project.use.viewport ?? null;
  test.skip((viewport?.width ?? 0) < 1024, 'Phones read in the sheet (AC-3).');
  const page = await readerWith(browser, viewport, turn('ritmo e vida'));
  await shot(page, 'chat-research-answer-closed');
  const answer = page.locator('app-research-message');
  await answer.locator('a.cite').nth(1).click();
  const panel = page.locator('app-document-panel');
  await expect(panel.getByText('Fonte 2 de 2')).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'A Árvore da Vida' }),
  ).toBeVisible();
  await expect(panel.locator('.body mark').first()).toBeVisible();
  await expect(answer.locator('a.cite').nth(1)).toHaveClass(/active/);
  await expect(answer.locator('.source.active')).toContainText(
    'A Árvore da Vida',
  );
  // The answer stays on screen beside the source (BR-4).
  await expect(answer.locator('.answer')).toBeInViewport();
  await shot(page, 'chat-research-answer');

  await panel.getByRole('button', { name: 'Fonte anterior' }).click();
  await expect(panel.getByText('Fonte 1 de 2')).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'A Lei do Ritmo' }),
  ).toBeVisible();
  await expect(panel.locator('.body mark').first()).toBeVisible();
  await expect(answer.locator('a.cite').first()).toHaveClass(/active/);

  // NFR-4: a source already read comes back with its passage marked within 500 ms.
  const started = Date.now();
  await panel.getByRole('button', { name: 'Próxima fonte' }).click();
  await expect(panel.locator('.body mark').first()).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'A Árvore da Vida' }),
  ).toBeVisible();
  expect(Date.now() - started).toBeLessThanOrEqual(500);

  await panel.getByRole('button', { name: 'Próximo trecho' }).click();
  await panel.getByRole('button', { name: 'Abrir documento' }).click();
  await expect(panel.getByText(/Fonte \d de 2/)).toHaveCount(0);
  await expect(
    panel.getByRole('complementary', { name: 'Sobre este documento' }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Tela cheia' }).click();
  await expect(panel).toHaveClass(/full/);
  await shot(page, 'chat-document');
  await page.context().close();
});

test('AC-3: on a phone [1] opens the reading sheet on "Fonte 1"; dragging it down returns to [1]', async ({
  browser,
}, testInfo) => {
  const viewport = testInfo.project.use.viewport ?? null;
  test.skip((viewport?.width ?? 0) >= 1024, 'Desktop reads beside it (AC-1).');
  const page = await readerWith(browser, viewport, turn('ritmo e vida'));
  await shot(page, 'chat-research-answer');
  const cite = page.locator('app-research-message a.cite').first();
  await cite.click();
  const sheet = page.getByRole('dialog', { name: 'Fonte' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', { name: 'Fonte 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    sheet.getByRole('heading', { name: 'A Lei do Ritmo' }),
  ).toBeVisible();
  await expect(sheet.locator('.body mark').first()).toBeVisible();
  // 85% of the screen: the answer is still there, under it.
  const box = await sheet.boundingBox();
  const height = viewport?.height ?? 0;
  expect(Math.round(box?.height ?? 0)).toBe(Math.round(height * 0.85));
  await shot(page, 'chat-research-answer-source');

  // The APG tabs: one Tab stop, arrows move the selection and the focus, and the panel is
  // named by the selected tab.
  const first = sheet.getByRole('tab', { name: 'Fonte 1' });
  const second = sheet.getByRole('tab', { name: 'Fonte 2' });
  await expect(first).toHaveAttribute('tabindex', '0');
  await expect(second).toHaveAttribute('tabindex', '-1');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(second).toHaveAttribute('tabindex', '0');
  await expect(sheet.getByRole('tabpanel', { name: 'Fonte 2' })).toBeVisible();
  await expect(
    sheet.getByRole('heading', { name: 'A Árvore da Vida' }),
  ).toBeVisible();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.keyboard.press('End');
  await expect(second).toBeFocused();

  // A labelled ✕ closes it, also in "Tela cheia", back to [1].
  await sheet.getByRole('button', { name: 'Tela cheia' }).click();
  await sheet.getByRole('button', { name: 'Fechar' }).click();
  await expect(sheet).toBeHidden();
  await expect(cite).toBeFocused();
  await cite.click();
  await expect(sheet).toBeVisible();

  const handle = sheet.locator('.sheet-head');
  const head = await handle.boundingBox();
  if (!head) throw new Error('The sheet has no head.');
  await page.mouse.move(head.x + 20, head.y + 6);
  await page.mouse.down();
  await page.mouse.move(head.x + 20, head.y + 160, { steps: 6 });
  await page.mouse.up();
  await expect(sheet).toBeHidden();
  await expect(cite).toBeFocused();
  await page.context().close();
});

test("BR-4: a source with none of the question's words says its passage was not found", async ({
  browser,
}, testInfo) => {
  const viewport = testInfo.project.use.viewport ?? null;
  const page = await readerWith(browser, viewport, turn('qa fontes'));
  await page.locator('app-research-message a.cite').first().click();
  const reader = phone(page)
    ? page.getByRole('dialog', { name: 'Fonte' })
    : page.locator('app-document-panel');
  await expect(
    reader.getByRole('heading', { name: 'A Lei do Ritmo' }),
  ).toBeVisible();
  await expect(reader.locator('.body mark')).toHaveCount(0);
  await expect(
    reader.getByRole('status').getByText(/Trecho não localizado/),
  ).toBeVisible();
  // Nothing to copy or step through, and the document is still a click away.
  await expect(
    reader.getByRole('button', { name: 'Copiar trecho' }),
  ).toHaveCount(0);
  await expect(
    reader.getByRole('button', { name: 'Abrir documento' }),
  ).toBeVisible();
  await shot(page, 'chat-research-source-no-passage');
  await page.context().close();
});

test('on a phone "Abrir documento" leaves the sheet for the document, with the focus on its title', async ({
  browser,
}, testInfo) => {
  const viewport = testInfo.project.use.viewport ?? null;
  test.skip((viewport?.width ?? 0) >= 1024, 'Only phones read in the sheet.');
  const page = await readerWith(browser, viewport, turn('ritmo e vida'));
  await page.locator('app-research-message a.cite').first().click();
  const sheet = page.getByRole('dialog', { name: 'Fonte' });
  await expect(
    sheet.getByRole('heading', { name: 'A Lei do Ritmo' }),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'Abrir documento' }).click();
  await expect(sheet).toBeHidden();
  const title = page
    .locator('app-document-panel')
    .getByRole('heading', { name: 'A Lei do Ritmo' });
  await expect(title).toBeVisible();
  // Not on the citation, which the full-screen document covers.
  await expect(title).toBeFocused();
  await page.context().close();
});

test('AC-7: the states of an answer: interrupted and failed, each with "Tentar de novo"', async ({
  browser,
}, testInfo) => {
  const viewport = testInfo.project.use.viewport ?? null;
  const page = await readerWith(
    browser,
    viewport,
    turn('natureza sétupla', {
      answer: 'Segundo o acervo, a natureza humana é descrita em sete planos',
      sources: [],
      interrupted: true,
    }),
  );
  const message = page.locator('app-research-message').last();
  await expect(
    message.getByText('interrompida', { exact: true }),
  ).toBeVisible();
  await expect(message.getByText('A resposta foi interrompida.')).toBeVisible();
  await expect(
    message.getByRole('button', { name: 'Tentar de novo' }),
  ).toBeVisible();
  await shot(page, 'chat-research-interrupted');
  const serious = (
    await new AxeBuilder({ page }).include('main').analyze()
  ).violations.filter(
    (violation) =>
      violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(serious).toEqual([]);
  await page.context().close();
});

test('AC-7: a document that fails says so with "Tentar de novo", and opens when it works again', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
  await page.goto('/');
  await page.getByLabel('Sua pergunta').fill('lei do ritmo');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  let fail = true;
  await page.route('**/documents/**', async (route) => {
    if (fail) {
      await route.fulfill({
        status: 503,
        json: { error: { code: 'SEARCH_UNAVAILABLE', message: 'down' } },
      });
      return;
    }
    await route.continue();
  });
  await page
    .getByRole('button', { name: /A Lei do Ritmo/ })
    .first()
    .click();
  const panel = page.locator('app-document-panel');
  await expect(
    panel.getByText('Não foi possível abrir “A Lei do Ritmo”'),
  ).toBeVisible();
  await shot(page, 'chat-document-error');
  fail = false;
  await panel.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(
    panel.getByRole('complementary', { name: 'Sobre este documento' }),
  ).toBeVisible();
  await shot(page, 'chat-document-page');
});

test('AC-7: "Novo acervo" with no name says why and keeps the dialog open', async ({
  page,
}) => {
  await page.goto('/');
  if (phone(page)) await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('button', { name: /Novo acervo/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Nome').fill('Rosacruz');
  await shot(page, 'chat-collection-new');
  await dialog.getByLabel('Nome').fill('   ');
  await dialog.getByRole('button', { name: 'Criar acervo' }).click();
  await expect(
    dialog.getByText('Escreva um nome com pelo menos uma letra ou número.'),
  ).toBeVisible();
  await expect(dialog.getByLabel('Nome')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await shot(page, 'chat-collection-invalid');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
});

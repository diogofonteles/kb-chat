import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { startInSearchView } from './search-view.js';

// KBC-126: the v2 conversation home and search page, at 1440 and 390 (BR-3). With
// KBC_SHOTS=<folder> each state is also captured, to compare with the v2 · Conversa frames.

test.beforeEach(startInSearchView);

const phone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 1024;

async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env['KBC_SHOTS'];
  if (!folder) return;
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `${folder}/${name}-${width}.png` });
}

/** A menu, popover or list is whole on the screen and drawn on top (D5, owner rule 1). */
async function expectWholeOnScreen(page: Page, panel: Locator): Promise<void> {
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const view = page.viewportSize();
  expect(box).not.toBeNull();
  if (!box || !view) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  const onTop = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + Math.min(rect.height / 2, 20),
    );
    return hit !== null && element.contains(hit);
  });
  expect(onTop).toBe(true);
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
}

const searchConversation = (topic: string, title: string, at: string) => ({
  kind: 'search',
  id: crypto.randomUUID(),
  topic,
  title,
  createdAt: at,
  updatedAt: at,
  asks: [
    {
      question: title,
      mode: 'all',
      filters: {
        concepts: [],
        genres: [],
        depths: [],
        relevances: [],
        authorships: [],
        topics: [],
      },
      total: null,
    },
  ],
});

const researchConversation = (topic: string, title: string, at: string) => ({
  kind: 'research',
  id: crypto.randomUUID(),
  topic,
  title,
  createdAt: at,
  updatedAt: at,
  turns: [
    {
      id: crypto.randomUUID(),
      question: title,
      answer: 'Segundo o acervo, “A Lei do Ritmo” trata do assunto [1].',
      sources: [{ n: 1, id: 'raw/lei-do-ritmo.md', title: 'A Lei do Ritmo' }],
      steps: 2,
      usd: 0,
      billing: 'subscription',
      model: 'stub/model',
      interrupted: false,
      at,
    },
  ],
});

test('AC-1: the recent shortcuts are the history in the order of its last use, and one opens', async ({
  browser,
}, testInfo) => {
  const owner = await ownerApi();
  const email = uniqueEmail('atalhos');
  await invite(owner, email, {
    topics: ['hermetismo', 'alquimia'],
    features: ['search', 'research'],
  });
  const member = await pageAs(
    browser,
    email,
    testInfo.project.use.viewport ?? null,
  );
  await member.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
  const minute = (n: number) =>
    new Date(Date.UTC(2026, 10, 16, 10, n)).toISOString();
  const saved = [
    researchConversation('hermetismo', 'o que é o ritmo?', minute(1)),
    searchConversation('hermetismo', 'lei do ritmo', minute(5)),
    researchConversation(
      'hermetismo',
      'quais livros o mestre cita?',
      minute(3),
    ),
    searchConversation('alquimia', 'transmutação', minute(4)),
    researchConversation(
      'hermetismo',
      'o que é a natureza sétupla?',
      minute(2),
    ),
  ];
  for (const conversation of saved) {
    const put = await member.request.put(
      `/api/v1/conversations/${conversation.id}`,
      { data: conversation, headers: CSRF },
    );
    expect(put.status(), await put.text()).toBe(200);
  }
  await member.goto('/');
  const recents = member.getByRole('navigation', { name: 'Recentes' });
  const titles = recents.locator('.tile-title');
  await expect(titles).toHaveText([
    'lei do ritmo',
    'transmutação',
    'quais livros o mestre cita?',
    'o que é a natureza sétupla?',
    'o que é o ritmo?',
    'Hermetismo',
  ]);
  await shot(member, 'chat-empty');
  await recents.getByRole('button', { name: /lei do ritmo/ }).click();
  await expect(member.locator('app-result-message .question')).toContainText(
    'lei do ritmo',
  );
  await member.context().close();
});

test('AC-3: the first result is the "Melhor resultado" and the others fill the table', async ({
  page,
}) => {
  await page.goto('/');
  await shot(page, 'chat-empty-owner');
  await ask(page, 'ritmo');
  const message = page.locator('app-result-message').last();
  const best = message.getByRole('region', { name: 'Melhor resultado' });
  const rest = message.getByRole('region', { name: 'Documentos' });
  await expect(best.locator('app-result-card')).toHaveCount(1);
  const cards = await message.locator('app-result-card').count();
  await expect(rest.locator('app-result-card')).toHaveCount(cards - 1);
  // The order is the search's: the best one is the first of the list (BR-4).
  expect(
    await message
      .locator('app-result-card')
      .first()
      .evaluate((card) =>
        card.closest('section')?.classList.contains('best-column'),
      ),
  ).toBe(true);
  await expect(message.locator('.summary')).toContainText(
    /documentos · Tudo ·/,
  );
  await shot(page, 'chat-results');
  if (!phone(page)) {
    // At 1440 the search page uses the main panel: the best result is a card left of the
    // table (FR-2), and both column headings are shown.
    await expect(
      best.getByRole('heading', { name: 'Melhor resultado' }),
    ).toBeVisible();
    await expect(
      rest.getByRole('heading', { name: 'Documentos' }),
    ).toBeVisible();
    const bestBox = await best.boundingBox();
    const restBox = await rest.boundingBox();
    if (!bestBox || !restBox)
      throw new Error('Both result columns must render.');
    expect(bestBox.x + bestBox.width).toBeLessThanOrEqual(restBox.x);
    expect(Math.abs(bestBox.y - restBox.y)).toBeLessThan(8);
  }
});

test('AC-4: a subject in the popover filters, shows its chip, and Escape returns to the chip', async ({
  page,
}) => {
  test.skip(phone(page), 'Phones filter in the sheet (AC-5).');
  await page.goto('/');
  await page.getByRole('radio', { name: 'Por significado' }).check();
  await ask(page, 'natureza');
  const chip = page.getByRole('button', { name: /^Assuntos/ });
  await chip.click();
  const popover = page.getByRole('group', { name: 'Assuntos' });
  await expectWholeOnScreen(page, popover);
  await shot(page, 'chat-results-filter-popover');
  await popover.getByRole('checkbox', { name: /Cabala/ }).check();
  await expect(
    page.getByRole('button', { name: 'Remover Assuntos: Cabala' }),
  ).toBeVisible();
  await expect(page.getByText(/2 documentos ·/)).toBeVisible();
  await popover.getByRole('checkbox', { name: /Cabala/ }).press('Escape');
  await expect(popover).toBeHidden();
  await expect(chip).toBeFocused();
  await shot(page, 'chat-results-filtered');
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(
    page.getByRole('button', { name: 'Remover Assuntos: Cabala' }),
  ).toHaveCount(0);
  await expect(page.getByText(/3 documentos ·/)).toBeVisible();
});

test('AC-5: on a phone the sheet says how many results a type shows, and shows them', async ({
  page,
}) => {
  test.skip(!phone(page), 'Desktop filters in popovers (AC-4).');
  await page.goto('/');
  await page.getByRole('radio', { name: 'Por significado' }).check();
  await ask(page, 'natureza');
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await expect(sheet).toBeVisible();
  const type = sheet.locator('[data-sheet-facet="genres"] label').first();
  const expected = Number(
    (await type.locator('.option-count').textContent())?.trim(),
  );
  await type.getByRole('checkbox').check();
  const apply = sheet.getByRole('button', {
    name: expected === 1 ? 'Ver 1 resultado' : `Ver ${expected} resultados`,
  });
  await shot(page, 'chat-filters-sheet');
  await apply.click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('app-result-card')).toHaveCount(expected);
  await expect(page.getByRole('button', { name: 'Filtros (1)' })).toBeVisible();
});

test('the collection menu of the home is whole on screen and switches the collection', async ({
  page,
}) => {
  await page.goto('/');
  const trigger = page
    .locator('app-conversation-home')
    .getByRole('button', { name: /Hermetismo · / });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Trocar de acervo' });
  await expectWholeOnScreen(page, menu);
  // No browser popover box: no border, no centring margin.
  expect(
    await menu.evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe('0px');
  if (phone(page)) {
    // On a phone it is the full-width sheet at the foot, over a scrim.
    const box = await menu.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) throw new Error('The menu must render.');
    expect(Math.round(box.width)).toBe(view.width);
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.y + box.height)).toBe(view.height);
    expect(
      await menu.evaluate(
        (element) => getComputedStyle(element, '::backdrop').backgroundColor,
      ),
    ).not.toBe('rgba(0, 0, 0, 0)');
  }
  await shot(page, 'chat-collection-menu');
  await menu.getByRole('menuitem', { name: /Alquimia/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Alquimia',
  );
});

test('the states of the results: nothing found and the error, each with its action', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Palavras exatas' }).check();
  await page.getByLabel('Sua pergunta').fill('xqzw kplvm');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(
    page.getByText('Nada encontrado para "xqzw kplvm".'),
  ).toBeVisible();
  await shot(page, 'chat-results-none');
  await page.route('**/searches', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'SEARCH_UNAVAILABLE', message: 'down' } },
    }),
  );
  await page.getByLabel('Sua pergunta').fill('lei do ritmo');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  const error = page.locator('app-result-message .answer.error').last();
  await expect(error).toBeVisible();
  await expect(
    error.getByRole('button', { name: 'Tentar de novo' }),
  ).toBeVisible();
  await shot(page, 'chat-results-error');
});

for (const theme of ['revised', 'light', 'dark', 'esoteric']) {
  test(`NFR-1: the home and the results have no serious or critical axe violation (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript(
      (chosen) => localStorage.setItem('kb-chat.theme', chosen),
      theme,
    );
    await page.goto('/');
    await expect(page.getByText('O que você quer estudar hoje?')).toBeVisible();
    const serious = async () =>
      (
        await new AxeBuilder({ page }).include('main').analyze()
      ).violations.filter(
        (violation) =>
          violation.impact === 'serious' || violation.impact === 'critical',
      );
    expect(await serious()).toEqual([]);
    await ask(page, 'ritmo');
    expect(await serious()).toEqual([]);
  });
}

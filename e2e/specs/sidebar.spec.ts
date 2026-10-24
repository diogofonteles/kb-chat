import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** On phones the side panel lives in the "Menu" drawer (KBC-005 FR-6). */
async function sidebar(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
}

/** The history is shared by every test of the run (it lives on the API): each test tags its own. */
const uniqueTag = (): string => `e2e${randomUUID().slice(0, 8)}`;

const historyOf = async (page: Page) =>
  (await sidebar(page)).getByRole('navigation', { name: 'Histórico' });

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
  const tag = uniqueTag();
  await ask(page, `ritmo ${tag}`);
  await (
    await sidebar(page)
  )
    .getByRole('button', { name: /Nova conversa/ })
    .click();
  await expect(page.getByText('O que você quer estudar hoje?')).toBeVisible();
  await expect(page.getByLabel('Sua pergunta')).toBeFocused();
  await ask(page, `natureza ${tag}`);
  const history = await historyOf(page);
  await expect(
    history.getByRole('button', { name: new RegExp(tag) }),
  ).toHaveCount(2);
  const old = history.getByRole('button', { name: `ritmo ${tag}` });
  await expect(old).toContainText('Busca');
  await old.click();
  // The restored conversation runs its search again; the other one is gone from the screen.
  await expect(page.locator('app-result-message .question')).toHaveText([
    new RegExp(`ritmo ${tag}`),
  ]);
  await expect(page.locator('app-result-card').first()).toBeVisible();
});

test('the history is kept on this computer: it survives a reload and another browser', async ({
  page,
  browser,
  baseURL,
}) => {
  const question = `ritmo ${uniqueTag()}`;
  await ask(page, question);
  await expect(
    (await historyOf(page)).getByRole('button', { name: question }),
  ).toBeVisible();
  await page.reload();
  await expect(
    (await historyOf(page)).getByRole('button', { name: question }),
  ).toBeVisible();
  const other = await browser.newContext({ baseURL });
  const fresh = await other.newPage();
  await fresh.goto('/');
  const history = await historyOf(fresh);
  await history.getByRole('button', { name: question }).click();
  await expect(fresh.locator('app-result-message .question')).toHaveText([
    new RegExp(question),
  ]);
  await other.close();
});

test('lists every conversation, with no cap of 50', async ({ page }) => {
  const tag = uniqueTag();
  for (let n = 1; n <= 60; n++) {
    const id = randomUUID();
    const at = new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString();
    const title = `${tag} lote ${n}`;
    const response = await page.request.put(`/api/v1/conversations/${id}`, {
      data: {
        kind: 'search',
        id,
        topic: 'hermetismo',
        title,
        createdAt: at,
        updatedAt: at,
        asks: [
          {
            question: title,
            mode: 'all',
            filters: { concepts: [], genres: [], depths: [], relevances: [] },
            total: 1,
          },
        ],
      },
    });
    expect(response.status()).toBe(200);
  }
  await page.reload();
  const history = await historyOf(page);
  await expect(
    history.getByRole('button', { name: new RegExp(tag) }),
  ).toHaveCount(60);
  // The oldest is at the bottom of the scrollable list, and reachable.
  const oldest = history.getByRole('button', {
    name: new RegExp(`${tag} lote 1(?!\\d)`),
  });
  await oldest.scrollIntoViewIfNeeded();
  await expect(oldest).toBeVisible();
});

test('moves the old browser history to this computer once', async ({
  page,
}) => {
  const question = `ritmo ${uniqueTag()}`;
  await page.evaluate((q) => {
    localStorage.setItem(
      'kb-chat.history',
      JSON.stringify([
        {
          id: crypto.randomUUID(),
          topic: 'hermetismo',
          asks: [
            {
              question: q,
              mode: 'all',
              filters: { concepts: [], genres: [], depths: [], relevances: [] },
              total: 1,
            },
          ],
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
  }, question);
  await page.reload();
  await expect(
    (await historyOf(page)).getByRole('button', { name: question }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('kb-chat.history')))
    .toBeNull();
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

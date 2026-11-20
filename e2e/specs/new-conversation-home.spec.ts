import type { Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady, type UploadedMedia } from './media-helpers.js';
import { chooseView, expectView } from './search-view.js';
import {
  activeCollection,
  collectionBySlug,
  desktop,
  library,
  signOut,
  startNewCollection,
} from './shell-helpers.js';

/**
 * KBC-164: whoever enters the app lands on a new conversation (opening it, signing in,
 * reloading), a deep link still opens its page, and a conversation and a collection are
 * created apart ("+ Nova conversa"; the "+" of the Acervos head). At 1440 and 390.
 */

const RESEARCH_GREETING = 'O que você quer pesquisar no acervo?';
const SEARCH_GREETING = 'O que você quer estudar hoje?';

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
    });
}

const answers = (page: Page) => page.locator('app-research-message');

/** Asks the AI research and waits for its answer (the stub provider's). */
async function researchAnswered(page: Page, question: string): Promise<void> {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Perguntar' }).click();
  await expect(
    answers(page)
      .last()
      .getByText(/Resposta gerada por IA/),
  ).toBeVisible({ timeout: 30_000 });
}

/** Searches the documents and waits for the results. */
async function searched(page: Page, question: string): Promise<void> {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-message').first()).toBeVisible();
}

/** The new-conversation home: the greeting, nothing asked and, on a desktop, the box in focus. */
async function expectHome(page: Page, greeting: string): Promise<void> {
  await expect(page.getByText(greeting)).toBeVisible();
  await expect(answers(page)).toHaveCount(0);
  await expect(page.locator('app-result-message')).toHaveCount(0);
  if (desktop(page))
    await expect(page.getByLabel('Sua pergunta')).toBeFocused();
}

/** A unique name that sorts after the fixture collections. */
const uniqueName = (label: string): string =>
  `Zz ${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const slugOf = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
});

test('AC-1: a reload lands on a new conversation, in the remembered view; the one open stays in Conversas', async ({
  page,
}) => {
  await expectView(page, 'research');
  const question = `natureza sétupla ${uniqueTag()}`;
  await researchAnswered(page, question);
  await page.reload();
  await expectHome(page, RESEARCH_GREETING);
  await expectView(page, 'research');
  await shoot(page, 'kbc164-reload-home');
  // One click away in Sua biblioteca.
  await (
    await library(page)
  )
    .getByRole('navigation', { name: 'Conversas' })
    .getByRole('button', { name: new RegExp(question) })
    .click();
  await expect(answers(page).getByText(/Resposta gerada por IA/)).toBeVisible();

  // The search view too, and it stays the view after the reload.
  await chooseView(page, 'search');
  await searched(page, 'ritmo');
  await page.reload();
  await expectHome(page, SEARCH_GREETING);
  await expectView(page, 'search');
});

test('AC-2: signing in shows the home, nothing of before', async ({ page }) => {
  await researchAnswered(page, `natureza sétupla ${uniqueTag()}`);
  await signOut(page);
  await page.getByRole('button', { name: 'Fazer login com o Google' }).click();
  await expectHome(page, RESEARCH_GREETING);
});

test.describe('a deep link', () => {
  let media: UploadedMedia;

  test.beforeAll(async () => {
    const owner = await ownerApi();
    media = await uploadReady(owner, {
      title: `Aula do link ${uniqueTag()}`,
      seconds: 4,
    });
    await owner.dispose();
  });

  test('AC-3: /midia/<id> still opens its page, after a reload too', async ({
    page,
  }) => {
    await page.goto(`/midia/${media.id}`);
    await expect(
      page.getByRole('heading', { name: media.title }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: media.title }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/midia/${media.id}`);
    await expect(page.getByText(RESEARCH_GREETING)).toHaveCount(0);
  });
});

test('AC-4: "+ Nova conversa" starts one, in the column and in the phone header of both views', async ({
  page,
}) => {
  await chooseView(page, 'search');
  await searched(page, 'ritmo');
  const start = desktop(page)
    ? (await library(page)).getByRole('button', {
        name: 'Nova conversa',
        exact: true,
      })
    : page.locator('header.topbar').getByRole('button', {
        name: 'Nova conversa',
      });
  await expect(start).not.toHaveAttribute('aria-haspopup');
  await shoot(page, 'kbc164-new-conversation');
  await start.click();
  await expectHome(page, SEARCH_GREETING);
  await expect(page.getByRole('menu')).toHaveCount(0);

  if (!desktop(page)) {
    // The research view's header has it too.
    await chooseView(page, 'research');
    await researchAnswered(page, `natureza sétupla ${uniqueTag()}`);
    await page
      .locator('header.topbar')
      .getByRole('button', { name: 'Nova conversa' })
      .click();
    await expectHome(page, RESEARCH_GREETING);
  }
});

test('AC-5: the Acervos "+" creates a collection without a new conversation or another collection in use', async ({
  page,
}) => {
  await chooseView(page, 'search');
  await searched(page, 'ritmo');
  const before = await activeCollection(await library(page)).getAttribute(
    'data-slug',
  );
  expect(before).not.toBeNull();
  const name = uniqueName('Novo');
  await startNewCollection(page);
  const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(name);
  await dialog.getByRole('button', { name: 'Criar acervo' }).click();
  await expect(dialog).toBeHidden();
  const side = await library(page);
  await expect(collectionBySlug(side, slugOf(name))).toBeVisible();
  await expect(collectionBySlug(side, slugOf(name))).not.toHaveAttribute(
    'aria-current',
  );
  await expect(activeCollection(side)).toHaveAttribute(
    'data-slug',
    before ?? '',
  );
  await shoot(page, 'kbc164-collection-created');
  if (!desktop(page)) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
  }
  // The conversation on screen is the same: its results, no notice of another collection.
  await expect(page.locator('app-result-message').first()).toBeVisible();
  await expect(page.getByText(/Nova conversa em/)).toHaveCount(0);
});

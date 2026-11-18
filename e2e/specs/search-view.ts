import { expect, type Page } from '@playwright/test';

/**
 * With the stub provider the app opens in "Pesquisa com IA" (KBC-008); the search-engine
 * specs start in "Buscar documentos", as a reader who chose it (remembered in kb-chat.view).
 */
export async function startInSearchView({ page }: { page: Page }) {
  await page.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
}

/**
 * A mode of the question box (Tudo, Palavras exatas, Por significado). On a phone the modes
 * float over the box only while it is in use (v2 · Conversa, cmComposer): it takes the focus
 * first. Returns the radio, to check it or read whether it is checked.
 */
export async function modeRadio(page: Page, name: string) {
  if (isPhone(page)) await page.getByLabel('Sua pergunta').focus();
  return page.locator('app-composer').getByRole('radio', { name });
}

const isPhone = (page: Page): boolean =>
  (page.viewportSize()?.width ?? 1440) < 1024;

/** The scope chip of a view: "Tudo" (the search) or "Pesquisa com IA" (v2 · Conversa). */
export function viewRadio(page: Page, view: 'search' | 'research') {
  return page
    .getByRole('radiogroup', { name: 'Onde buscar' })
    .getByRole('radio', {
      name: view === 'search' ? 'Tudo' : /Pesquisa com IA/,
    });
}

/**
 * Switches between the search and the AI research as a person would here: the scope chips
 * where the page shows them; else, on desktop, the top bar's ✦ (a search page has no
 * chips), and on a phone the navigation (Buscar; Conversas from a search page).
 */
export async function chooseView(
  page: Page,
  view: 'search' | 'research',
): Promise<void> {
  // The page first: the question box or, on a desktop search page, its results.
  await page.locator('app-composer, app-result-message').first().waitFor();
  const chip = viewRadio(page, view);
  if (await chip.isVisible()) {
    // A click, not check(): on desktop the chips leave with the switch when the search has
    // results on screen (a search page has its own head).
    await chip.click();
    return;
  }
  if (isPhone(page)) {
    await page
      .getByRole('navigation', { name: 'Navegação' })
      .getByRole('link', { name: view === 'search' ? 'Buscar' : 'Conversas' })
      .click();
    return;
  }
  // A desktop search page is the search already; its way to the research is ✦.
  if (view === 'research')
    await page
      .locator('app-top-bar')
      .getByRole('button', { name: 'Pesquisa com IA' })
      .click();
}

/**
 * The view on screen: on desktop its scope chip is the checked one; on a phone (the research
 * home draws the profiles instead of the chips) the question box asks or searches.
 */
export async function expectView(
  page: Page,
  view: 'search' | 'research',
): Promise<void> {
  if (!isPhone(page)) {
    await expect(viewRadio(page, view)).toBeChecked();
    return;
  }
  await expect(
    page.locator('app-composer').getByRole('button', {
      name: view === 'search' ? 'Buscar' : 'Perguntar',
    }),
  ).toBeVisible();
}

/** The results' head: the count of the last search and the mode it ran in. */
export async function expectSummary(
  page: Page,
  count: RegExp,
  mode: string,
): Promise<void> {
  const message = page.locator('app-result-message').last();
  await expect(message.locator('.summary .found')).toHaveText(count);
  await expect(
    message.getByRole('button', { name: `Modo da busca: ${mode}` }),
  ).toBeVisible();
}

/**
 * A new search from a search page: on desktop in the top bar's field (the page has no
 * question box, v2 · Conversa chat-results), on a phone in the search pill under "Buscar".
 */
export async function searchAgain(page: Page, question: string): Promise<void> {
  if (isPhone(page)) {
    await page.getByLabel('Sua pergunta').fill(question);
    await page
      .locator('app-composer')
      .getByRole('button', { name: 'Buscar', exact: true })
      .click();
    return;
  }
  const field = page.getByRole('searchbox', {
    name: 'Buscar no acervo em uso',
  });
  await field.fill(question);
  await field.press('Enter');
}

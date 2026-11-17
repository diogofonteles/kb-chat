import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';

/**
 * The v2 shell (KBC-125) as the specs reach it, at 1440 and 390: on desktop "Sua biblioteca"
 * is a column and Configurações, Pessoas e permissões, Como usar and Sair live in the avatar
 * menu of the top bar; on a phone all of them are in the "Menu" (the avatar of the header).
 */
export const desktop = (page: Page): boolean =>
  (page.viewportSize()?.width ?? 0) >= 1024;

/** "Sua biblioteca": the column, or the phone's Menu opened. */
export async function library(page: Page): Promise<Locator> {
  if (desktop(page))
    return page.getByRole('complementary', { name: 'Sua biblioteca' });
  const menu = page.getByRole('dialog', { name: 'Menu' });
  if (await menu.isVisible()) return menu;
  const button = page.getByRole('button', { name: 'Menu', exact: true });
  // A page under another (the album page, media-list@mobile) has "←" where the avatar is:
  // the menu is one step back.
  const back = page.getByRole('link', { name: 'Voltar', exact: true });
  await expect(button.or(back).first()).toBeVisible();
  if (await back.isVisible()) {
    await back.click();
    await expect(back).toHaveCount(0);
  }
  await button.click();
  return menu;
}

/** The avatar menu of the top bar (desktop). */
async function accountMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Conta de / }).click();
  return page.getByRole('menu', { name: 'Conta' });
}

/**
 * Where the person signed in is named: the avatar menu's heading on desktop (opened), the
 * account at the top of the phone's Menu.
 */
export async function account(page: Page): Promise<Locator> {
  if (desktop(page)) return accountMenu(page);
  return library(page);
}

/** An entry of the avatar menu (desktop) or of the phone's Menu. */
async function accountEntry(
  page: Page,
  name: string | RegExp,
): Promise<Locator> {
  if (desktop(page))
    return (await accountMenu(page)).getByRole('menuitem', { name });
  return (await library(page)).getByRole('button', { name });
}

export async function openSettings(page: Page): Promise<void> {
  await (await accountEntry(page, 'Configurações')).click();
}

/** "Pessoas e permissões": the top bar's button on desktop, the Menu's entry on a phone. */
export async function openPeople(page: Page): Promise<void> {
  if (desktop(page))
    await page
      .locator('app-top-bar')
      .getByRole('button', { name: /Pessoas e permissões/ })
      .click();
  else
    await (
      await library(page)
    )
      .getByRole('button', { name: /Pessoas e permissões/ })
      .click();
}

export async function signOut(page: Page): Promise<void> {
  await (await accountEntry(page, 'Sair')).click();
}

/** "+ Criar" › "Nova conversa". */
export async function startNewConversation(page: Page): Promise<void> {
  const side = await library(page);
  await side.getByRole('button', { name: 'Criar', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Nova conversa' }).click();
}

/** "+ Criar" › "Novo acervo". */
export async function startNewCollection(page: Page): Promise<void> {
  const side = await library(page);
  await side.getByRole('button', { name: 'Criar', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Novo acervo' }).click();
}

/** A collection's own button in the "Acervos" tree (D5: a row with its caret and edit). */
const COLLECTION_BUTTON = 'li.collection > .row > button.ui-libitem-row';

/** A collection of the list (the v1 "Acervo" selector, BR-4), by its title. */
export function collectionItem(side: Locator, title: string): Locator {
  return side.locator(COLLECTION_BUTTON).filter({
    has: side.page().locator('.ui-libitem__title').getByText(title, {
      exact: true,
    }),
  });
}

/** Makes `title` the collection in use from Sua biblioteca. */
export async function chooseCollection(
  page: Page,
  title: string,
): Promise<void> {
  await collectionItem(await library(page), title).click();
}

/** The collections of Sua biblioteca (their buttons, in order). */
export const collectionButtons = (side: Locator): Locator =>
  side.locator(COLLECTION_BUTTON);

/** The collection of `slug` in the list. */
export const collectionBySlug = (side: Locator, slug: string): Locator =>
  side.locator(`${COLLECTION_BUTTON}[data-slug="${slug}"]`);

/** The collection in use (aria-current). */
export const activeCollection = (side: Locator): Locator =>
  side.locator(`${COLLECTION_BUTTON}[aria-current="true"]`);

/** Makes the collection of `slug` the one in use (the phone's Menu closes by itself). */
export async function chooseCollectionSlug(
  page: Page,
  slug: string,
): Promise<void> {
  await collectionBySlug(await library(page), slug).click();
}

/** The titles of the collections, in the list's order. */
export async function collectionTitles(side: Locator): Promise<string[]> {
  return (
    await side.locator('li.collection .ui-libitem__title').allTextContents()
  ).map((text) => text.trim());
}

/**
 * Opens Mídia (or Biblioteca) from Sua biblioteca: the pinned item when the collection has
 * audio, else "+ Criar" › "Mídia", where the audio rule keeps it for a collection without
 * any audio yet (KBC-125 BR-2: no v1 action is lost).
 */
export async function openMediaFromLibrary(
  page: Page,
  name: 'Mídia' | 'Biblioteca' = 'Mídia',
): Promise<void> {
  const side = await library(page);
  // The audio rule settles once the collection's media list has answered.
  await page.waitForLoadState('networkidle');
  const pinned = side.getByRole('link', { name, exact: true });
  if ((await pinned.count()) > 0) {
    await pinned.click();
    return;
  }
  await side.getByRole('button', { name: 'Criar', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

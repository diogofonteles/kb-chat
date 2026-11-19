import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import {
  openPeople as shellOpenPeople,
  openSettings as shellOpenSettings,
} from './shell-helpers.js';

/**
 * Configurações as a page (KBC-131, KBC-132): the shell's entry opens /configuracoes; on desktop
 * the index scrolls to a section, on a phone the root opens each section as a pushed screen.
 * The helpers take the page or any locator in it (the settings region a spec holds).
 */
type Where = Page | Locator;
const pageOf = (where: Where): Page => ('goto' in where ? where : where.page());

export const desktop = (where: Where) =>
  (pageOf(where).viewportSize()?.width ?? 0) >= 1024;

/** The page itself: a region named "Configurações", at both widths. */
export const settingsPage = (where: Where): Locator =>
  pageOf(where).getByRole('region', { name: 'Configurações' });

/** One section of the page, by its title (a region of its own at both widths). */
export const settingsSection = (where: Where, label: string): Locator =>
  settingsPage(where).getByRole('region', { name: label, exact: true });

/**
 * The Configurações entry of the v2 shell (KBC-125): the avatar menu of the top bar on
 * desktop, the "Menu" on phones (FR-6). It opens the page, at `section` when given.
 */
export async function openSettings(
  where: Where,
  section?: string,
): Promise<Locator> {
  const page = pageOf(where);
  await shellOpenSettings(page);
  return atSettings(page, section);
}

/**
 * "Pessoas e permissões": the top bar's button on desktop, the Menu's entry on a phone. Both
 * open Configurações at that section; the settings region comes back.
 */
export async function openPeople(where: Where): Promise<Locator> {
  const page = pageOf(where);
  await shellOpenPeople(page);
  await atSettings(page);
  await expect(settingsSection(page, 'Pessoas e permissões')).toBeVisible();
  return settingsPage(page);
}

/** The page is open: then, when asked, at `section`. */
async function atSettings(page: Page, section?: string): Promise<Locator> {
  const settings = settingsPage(page);
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/configuracoes/);
  if (!section) return settings;
  await openSection(page, section);
  return settingsSection(page, section);
}

/**
 * A section by its index entry: the index link on desktop; on a phone, back to the root
 * ("‹") when another section is open, then the section's row.
 */
export async function openSection(where: Where, label: string): Promise<void> {
  const page = pageOf(where);
  const settings = settingsPage(page);
  const index = settings.getByRole('navigation', { name: 'Seções' });
  if (desktop(page)) {
    await index.getByRole('link', { name: label, exact: true }).click();
    await expect(
      index.getByRole('link', { name: label, exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    return;
  }
  const back = settings.getByRole('button', {
    name: 'Voltar às configurações',
  });
  if (await back.isVisible()) await back.click();
  await index.getByRole('link', { name: label, exact: true }).click();
  await expect(
    settings.getByRole('heading', { name: label, exact: true, level: 2 }),
  ).toBeVisible();
}

/** Leaving Configurações: back to where it was opened from, as the browser's back does. */
export async function closeSettings(where: Where): Promise<void> {
  const page = pageOf(where);
  for (let step = 0; step < 10 && /\/configuracoes/.test(page.url()); step++) {
    const before = page.url();
    await page.goBack();
    // A single-page app answers "back" without a load: wait for the address to move.
    await page.waitForURL((url) => url.href !== before);
  }
  await expect(settingsPage(page)).toBeHidden();
}

/** A person's editor, a modal named after the person (KBC-132 FR-2). */
export const personEditor = (where: Where, name: string | RegExp): Locator =>
  pageOf(where).getByRole('dialog', { name });

/**
 * One of an editor's tabs: Acessos · IA e limites (· Preferências iniciais). In the open
 * modal when there is one (a person, the configured invitation), else in `where`.
 */
export async function showTab(where: Where, tab: string): Promise<void> {
  const page = pageOf(where);
  const modal = page.getByRole('dialog');
  const scope =
    (await modal.count()) > 0 ? modal : 'goto' in where ? page : where;
  const button = scope.getByRole('tab', { name: tab, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
}

/** What axe checks on Configurações: the page and any modal open over it. */
export const SETTINGS_AXE = 'section[aria-label="Configurações"], dialog[open]';

/**
 * A profile's action: the words on its row on a desktop; on a phone they are in its ⋯ menu
 * (v2 · Perfis, celular).
 */
export async function profileAction(
  section: Locator,
  action: 'Editar' | 'Apagar' | 'Tornar padrão',
  name: string,
): Promise<void> {
  if ((section.page().viewportSize()?.width ?? 0) < 1024) {
    await section
      .getByRole('button', { name: `Mais ações de ${name}` })
      .click();
    await section
      .page()
      .getByRole('menuitem', { name: action, exact: true })
      .click();
    return;
  }
  await section.getByRole('button', { name: `${action} ${name}` }).click();
}

/**
 * Starts a selection in Pessoas e permissões with this person. A phone's list shows its
 * boxes once a selection is on: a long press (its context menu) on a row starts it; the
 * next people are checked by their boxes.
 */
export async function selectFirstPerson(
  section: Locator,
  email: string,
): Promise<void> {
  const page = section.page();
  const box = section.getByLabel(`Selecionar ${email}`);
  if (!desktop(page))
    await section
      .getByRole('button', { name: new RegExp(email.replace(/[.]/g, '\\.')) })
      .dispatchEvent('contextmenu');
  await box.check();
}

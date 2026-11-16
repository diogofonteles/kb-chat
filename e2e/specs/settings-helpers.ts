import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';

/**
 * Configurações as a page (KBC-131, KBC-132): the ⚙ entry opens /configuracoes; on desktop
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

/** The ⚙ entry: in the side panel on desktop, in the "Menu" drawer on phones (FR-6). */
export async function openSettings(
  where: Where,
  section?: string,
): Promise<Locator> {
  const page = pageOf(where);
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page
    .getByRole('button', { name: 'Configurações', exact: true })
    .click();
  const settings = settingsPage(page);
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/configuracoes/);
  if (!section) return settings;
  await openSection(page, section);
  return settingsSection(page, section);
}

/** "Pessoas e permissões" from the ⚙ entry: the settings region, at that section. */
export async function openPeople(where: Where): Promise<Locator> {
  await openSettings(where, 'Pessoas e permissões');
  return settingsPage(where);
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

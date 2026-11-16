import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';

/**
 * Configurações as a page (KBC-131): the ⚙ entry opens /configuracoes; on desktop the index
 * scrolls to a section, on a phone the root opens each section as a pushed screen.
 */
export const desktop = (page: Page) =>
  (page.viewportSize()?.width ?? 0) >= 1024;

/** The page itself: a region named "Configurações", at both widths. */
export const settingsPage = (page: Page): Locator =>
  page.getByRole('region', { name: 'Configurações' });

/** One section of the page, by its title (a region of its own at both widths). */
export const settingsSection = (page: Page, label: string): Locator =>
  settingsPage(page).getByRole('region', { name: label, exact: true });

/** The ⚙ entry: in the side panel on desktop, in the "Menu" drawer on phones (FR-6). */
export async function openSettings(
  page: Page,
  section?: string,
): Promise<Locator> {
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

/**
 * A section by its index entry: the index link on desktop; on a phone, back to the root
 * ("‹") when another section is open, then the section's row.
 */
export async function openSection(page: Page, label: string): Promise<void> {
  const settings = settingsPage(page);
  if (desktop(page)) {
    await settings
      .getByRole('navigation', { name: 'Seções' })
      .getByRole('link', { name: label, exact: true })
      .click();
    await expect(
      settings
        .getByRole('navigation', { name: 'Seções' })
        .getByRole('link', { name: label, exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    return;
  }
  const back = settings.getByRole('button', {
    name: 'Voltar às configurações',
  });
  if (await back.isVisible()) await back.click();
  await settings
    .getByRole('navigation', { name: 'Seções' })
    .getByRole('link', { name: label, exact: true })
    .click();
  await expect(
    settings.getByRole('heading', { name: label, exact: true, level: 1 }),
  ).toBeVisible();
}

/** Leaving Configurações: back to where it was opened from, as the browser's back does. */
export async function closeSettings(page: Page): Promise<void> {
  for (
    let step = 0;
    step < 10 && /\/configuracoes/.test(page.url());
    step += 1
  ) {
    const before = page.url();
    await page.goBack();
    // A single-page app answers "back" without a load: wait for the address to move.
    await page.waitForURL((url) => url.href !== before);
  }
  await expect(settingsPage(page)).toBeHidden();
}

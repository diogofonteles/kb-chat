import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, invite, ownerApi, test, uniqueEmail } from './fixtures.js';

/**
 * KBC-062: in "Pessoas e permissões" a master who uses only the keyboard checks collections
 * and features one after another; focus stays on the box while the change saves, and quick
 * changes are all kept, in order. The same holds in the invitation profile editor. 1440 and
 * 390 px.
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openPeople(page: Page): Promise<Locator> {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  const side = desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
  await side.getByRole('button', { name: /Pessoas e permissões/ }).click();
  return page.getByRole('dialog', { name: 'Configurações' });
}

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string, part: Locator): Promise<void> {
  if (shots)
    await part.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
    });
}

/** Tab forward, as a keyboard user does, until `target` has focus. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let step = 0; step < 15; step++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Each save takes a moment, as on a slow network: the next change comes before it ends. */
async function slowSaves(page: Page, ms = 400): Promise<void> {
  await page.route('**/api/v1/people/*', async (route) => {
    if (route.request().method() === 'PATCH')
      await new Promise((done) => setTimeout(done, ms));
    await route.continue();
  });
}

/** The person as the server keeps them. */
async function savedPerson(api: APIRequestContext, id: string) {
  const people = await api.get('/api/v1/people');
  return (
    (await people.json()) as {
      items: { id: string; topics: string[]; features: string[] }[];
    }
  ).items.find((person) => person.id === id);
}

/** WCAG 2.2 AA in the dialog as it stands: no serious or critical violation. */
async function expectAccessible(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(
    axe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);
}

test('AC-1, AC-2: checking boxes with the keyboard keeps focus and every change', async ({
  page,
}) => {
  const api = await ownerApi();
  const email = uniqueEmail('keyboard');
  const id = await invite(api, email);
  await slowSaves(page);

  const dialog = await openPeople(page);
  const row = dialog.getByRole('button', { name: new RegExp(email) });
  await row.focus();
  await page.keyboard.press('Enter');
  const editor = dialog.locator(`#person-${id}`);
  const collections = editor.getByRole('group', { name: 'Acervos' });
  const hermetismo = collections.getByRole('checkbox', { name: 'Hermetismo' });
  const alquimia = collections.getByRole('checkbox', { name: 'Alquimia' });
  const research = editor.getByRole('checkbox', { name: 'Pesquisa com IA' });

  // AC-1: Space checks the box; it is busy saving, and focus does not leave it.
  await tabTo(page, alquimia);
  await page.keyboard.press('Space');
  await expect(collections).toHaveAttribute('aria-busy', 'true');
  await expect(alquimia).toBeFocused();
  await expect(alquimia).toBeEnabled();
  await expect(collections).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.getByRole('status')).toContainText('Salvo.');
  await expect(alquimia).toBeFocused();
  await expect(alquimia).toBeChecked();

  // AC-2: two more changes in a row, the second before the first is saved.
  await tabTo(page, hermetismo);
  await page.keyboard.press('Space');
  await tabTo(page, research);
  await page.keyboard.press('Space');
  // The first of the two is still on its way.
  await expect(collections).toHaveAttribute('aria-busy', 'true');
  await expect(research).toBeFocused();
  await expectAccessible(page);
  await shoot(page, 'person-saving', editor);
  await expect(collections).toHaveAttribute('aria-busy', 'false');
  await expect(research).toBeFocused();
  await expect(hermetismo).toBeChecked();
  await expect(research).toBeChecked();
  await shoot(page, 'person-saved', editor);

  const saved = await savedPerson(api, id);
  expect(saved?.topics).toEqual(
    expect.arrayContaining(['alquimia', 'hermetismo']),
  );
  expect(saved?.features).toContain('research');
  await api.dispose();
});

test('BUG-1: closing and reopening the person while a change saves keeps it', async ({
  page,
}) => {
  const api = await ownerApi();
  const email = uniqueEmail('reopen');
  const id = await invite(api, email);
  await slowSaves(page, 2000);

  const dialog = await openPeople(page);
  const row = dialog.getByRole('button', { name: new RegExp(email) });
  await row.focus();
  await page.keyboard.press('Enter');
  const editor = dialog.locator(`#person-${id}`);
  const collections = editor.getByRole('group', { name: 'Acervos' });
  const alquimia = collections.getByRole('checkbox', { name: 'Alquimia' });
  const hermetismo = collections.getByRole('checkbox', { name: 'Hermetismo' });

  await tabTo(page, alquimia);
  await page.keyboard.press('Space');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('Enter');
  // Reopened while it saves: the change on its way shows checked, at once (no retry, so a
  // box that only catches up when the save lands does not pass).
  await expect(collections).toHaveAttribute('aria-busy', 'true');
  expect(await alquimia.isChecked()).toBe(true);
  await tabTo(page, hermetismo);
  await page.keyboard.press('Space');
  expect(await collections.getAttribute('aria-busy')).toBe('true');
  await expect(collections).toHaveAttribute('aria-busy', 'false', {
    timeout: 20_000,
  });
  await expect(alquimia).toBeChecked();
  await expect(hermetismo).toBeChecked();

  expect((await savedPerson(api, id))?.topics).toEqual(
    expect.arrayContaining(['alquimia', 'hermetismo']),
  );
  await api.dispose();
});

test('AC-3: the invitation profile editor keeps focus on the checked box', async ({
  page,
}) => {
  const dialog = await openPeople(page);
  const section = dialog.getByRole('region', { name: /Perfis de convite/ });
  await section.getByRole('button', { name: /Perfis de convite/ }).click();
  await section.getByRole('button', { name: 'Novo perfil' }).click();
  await expect(section.getByLabel('Nome do perfil')).toBeFocused();

  const alquimia = section.getByRole('checkbox', { name: 'Alquimia' });
  const research = section.getByRole('checkbox', { name: 'Pesquisa com IA' });
  await tabTo(page, alquimia);
  await page.keyboard.press('Space');
  await expect(alquimia).toBeChecked();
  await expect(alquimia).toBeFocused();
  await tabTo(page, research);
  await page.keyboard.press('Space');
  await expect(research).toBeChecked();
  await expect(research).toBeFocused();
  await expect(alquimia).toBeChecked();
  await expectAccessible(page);
  await shoot(page, 'profile-keyboard', section);

  // Nothing is saved: the draft is dropped.
  await section.getByRole('button', { name: 'Cancelar' }).click();
});

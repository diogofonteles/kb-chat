import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  expect,
  invite,
  ownerApi,
  test,
  uniqueEmail,
} from './fixtures.js';

/**
 * KBC-109 (T9, ADR 0036 §9): the level of a collection in an invitation profile, in the
 * invitation made with it and for a selection of people; a master has no level select. Each
 * project has its own collection (`zz-pessoas-<project>`, apps/api/src/e2e/server.ts): a scale
 * changes what everyone sees there. The profiles are never the default one (shared server).
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string, part?: Locator): Promise<void> {
  if (shots)
    await (part ?? page).screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
    });
}

async function openPeople(page: Page): Promise<Locator> {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  const side = desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
  await side.getByRole('button', { name: /Pessoas e permissões/ }).click();
  return page.getByRole('dialog', { name: 'Configurações' });
}

/** WCAG 2.2 AA in the dialog, and no sideways scroll on the page (AC-7). */
async function expectAccessible(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

const personRow = (dialog: Locator, email: string) =>
  dialog.getByRole('button', { name: new RegExp(email) });

test('AC-1, AC-6, AC-7: a profile at CI, the invitation made with it, the bulk bar and a master without a select', async ({
  page,
}, testInfo) => {
  const slug = `zz-pessoas-${testInfo.project.name}`;
  const title = `Zz Pessoas ${testInfo.project.name}`;
  const owner = await ownerApi();
  for (const code of ['QS', 'CI']) {
    const created = await owner.post(`/api/v1/topics/${slug}/levels`, {
      data: { code },
      headers: CSRF,
    });
    expect(created.status(), await created.text()).toBe(201);
  }
  const ana = uniqueEmail('nivel-ana');
  const bia = uniqueEmail('nivel-bia');
  await invite(owner, ana, { topics: [slug] });
  await invite(owner, bia, { topics: [slug] });
  const name = `Aluno ${slug} ${Date.now().toString(36)}`;
  const nova = uniqueEmail('nivel-nova');

  const dialog = await openPeople(page);

  // AC-1: the profile, through the screen, with "Nível em <acervo>" under the collection.
  const section = dialog.getByRole('region', { name: /Perfis de convite/ });
  await section.getByRole('button', { name: /Perfis de convite/ }).click();
  await section.getByRole('button', { name: 'Novo perfil' }).click();
  await section.getByLabel('Nome do perfil').fill(name);
  await expect(
    section.getByRole('combobox', { name: `Nível em ${title}` }),
  ).toHaveCount(0);
  await section.getByRole('checkbox', { name: title }).check();
  const level = section.getByRole('combobox', { name: `Nível em ${title}` });
  await expect(level).toHaveValue('qs');
  await level.selectOption('ci');
  await expectAccessible(page);
  await shoot(page, 'profile-level', section);
  await section.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(section.getByText(`Perfil "${name}" salvo.`)).toBeVisible();

  await dialog
    .locator('form.invite select[name="profile"]')
    .selectOption({ label: name });
  await dialog.getByLabel('Convidar por e-mail').fill(nova);
  await dialog
    .getByRole('checkbox', { name: 'Não enviar e-mail de convite' })
    .check();
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  await expect(personRow(dialog, nova)).toContainText(`${title} · CI`);
  await expect(
    dialog.getByRole('combobox', { name: `Nível em ${title}` }),
  ).toHaveValue('ci');

  // AC-6: two members and the owner selected; the owner is a master and is left out.
  for (const email of [ana, bia, OWNER_EMAIL])
    await dialog.getByRole('checkbox', { name: `Selecionar ${email}` }).check();
  const bar = dialog.getByRole('group', { name: 'Nível para várias pessoas' });
  await bar.getByRole('combobox', { name: 'Nível em' }).selectOption(slug);
  await bar
    .getByRole('combobox', { name: 'Nível', exact: true })
    .selectOption('ci');
  await shoot(page, 'people-level-bar', bar);
  await bar
    .getByRole('button', { name: 'Aplicar nível às selecionadas (3)' })
    .click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: `Nível CI em ${title} aplicado a 2 pessoas.` }),
  ).toContainText('Masters veem todos os níveis.');
  await expect(personRow(dialog, ana)).toContainText(`${title} · CI`);
  await expect(personRow(dialog, bia)).toContainText(`${title} · CI`);

  // AC-7: the owner's editor has no level select.
  await personRow(dialog, OWNER_EMAIL).first().click();
  await expect(
    dialog.getByText('Masters veem todos os níveis.').first(),
  ).toBeVisible();
  await expect(
    dialog.getByRole('combobox', { name: `Nível em ${title}` }),
  ).toHaveCount(0);
  await personRow(dialog, OWNER_EMAIL).first().click();

  // The member's editor: the select under her collection, its label visible (390 px too).
  await personRow(dialog, ana).click();
  const mine = dialog.getByRole('combobox', { name: `Nível em ${title}` });
  await expect(mine).toHaveValue('ci');
  await expect(
    dialog.getByText(`Nível em ${title}`, { exact: true }),
  ).toBeVisible();
  const box = await dialog
    .getByRole('checkbox', { name: title, exact: true })
    .boundingBox();
  const select = await mine.boundingBox();
  expect(select && box && select.y > box.y).toBe(true);
  await expectAccessible(page);
  await shoot(
    page,
    'person-level',
    dialog.getByRole('listitem').filter({ hasText: ana }),
  );

  const removed = await owner.get('/api/v1/invite-profiles');
  const profile = (
    (await removed.json()) as { items: { id: string; name: string }[] }
  ).items.find((one) => one.name === name);
  expect(profile).toBeDefined();
  await owner.delete(`/api/v1/invite-profiles/${profile?.id}`, {
    headers: CSRF,
  });
  await owner.dispose();
});

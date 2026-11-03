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

/** KBC-048: collections and sub-collections created on the screen (ADR 0028). */

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function sidebar(page: Page): Promise<Locator> {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
}

/** Names that sort after the fixture collections, unique per test run. */
const uniqueName = (label: string): string =>
  `Zz ${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const slugOf = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A member who may create collections and sees only `hermetismo`. */
async function aCreator(page: Page): Promise<Page> {
  const email = uniqueEmail('criadora');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'collection-create'],
  });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  return member;
}

async function create(
  page: Page,
  name: string,
  inside?: string,
): Promise<number> {
  const panel = await sidebar(page);
  await panel.getByRole('button', { name: '+ Novo acervo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(name);
  if (inside)
    await dialog
      .getByRole('combobox', { name: 'Dentro de' })
      .selectOption({ label: inside });
  const startedAt = Date.now();
  await dialog.getByRole('button', { name: 'Criar acervo' }).click();
  await expect(dialog).toBeHidden();
  const select = (await sidebar(page)).getByRole('combobox', {
    name: 'Acervo',
    exact: true,
  });
  await expect(select.locator('option:checked')).toContainText(name);
  const took = Date.now() - startedAt;
  if (!desktop(page)) await page.keyboard.press('Escape');
  return took;
}

test('AC-1, AC-2, NFR-1: a member creates a collection and a sub-collection and opens them at once', async ({
  page,
}) => {
  const member = await aCreator(page);
  const parent = uniqueName('UDV');
  const took = await create(member, parent);
  expect(took).toBeLessThanOrEqual(2000);
  await expect(member.getByRole('heading', { level: 1 })).toContainText(parent);
  await create(member, 'Palavra do Mestre', parent);
  const options = (await sidebar(member))
    .getByRole('combobox', { name: 'Acervo', exact: true })
    .locator('option');
  const texts = await options.allTextContents();
  const at = texts.findIndex((text) => text.trim().startsWith(parent));
  expect(at).toBeGreaterThanOrEqual(0);
  // Indented under its parent with no-break spaces, the only indent a <select> keeps.
  expect(texts[at + 1]).toMatch(/\u00a0{4}Palavra do Mestre \(0\)/);
  await member.context().close();
});

test('AC-7: a name already taken is refused in the dialog', async ({
  page,
}) => {
  const member = await aCreator(page);
  const name = uniqueName('Repetido');
  await create(member, name);
  const panel = await sidebar(member);
  await panel.getByRole('button', { name: '+ Novo acervo' }).click();
  const dialog = member.getByRole('dialog', { name: 'Novo acervo' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(name.toUpperCase());
  await dialog.getByRole('button', { name: 'Criar acervo' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Já existe um acervo com esse nome.',
  );
  await member.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await member.context().close();
});

test('AC-4: without "Criar acervos" there is no button and the API refuses', async ({
  page,
}) => {
  const email = uniqueEmail('leitora');
  const owner = await ownerApi();
  await invite(owner, email, { topics: ['hermetismo'], features: ['search'] });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  const panel = await sidebar(member);
  await expect(
    panel.getByRole('combobox', { name: 'Acervo', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '+ Novo acervo' }),
  ).toHaveCount(0);
  const refused = await member.request.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: 'Proibido' },
  });
  expect(refused.status()).toBe(403);
  await member.context().close();
});

test('AC-5: access to a sub-collection alone shows its parent as a closed group title', async ({
  page,
}) => {
  const parent = uniqueName('Pai');
  const owner = await ownerApi();
  const created = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: parent },
  });
  expect(created.status()).toBe(201);
  const child = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: 'Filho', parent: slugOf(parent) },
  });
  const childSlug = ((await child.json()) as { slug: string }).slug;
  const email = uniqueEmail('so-filho');
  await invite(owner, email, { topics: [childSlug], features: ['search'] });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  await expect(member.getByRole('heading', { level: 1 })).toContainText(
    'Filho',
  );
  const select = (await sidebar(member)).getByRole('combobox', {
    name: 'Acervo',
    exact: true,
  });
  await expect(
    select.locator(`option[value="${slugOf(parent)}"]`),
  ).toHaveAttribute('disabled', '');
  await expect(select.locator('option:checked')).toContainText('Filho');
  await member.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-8: the dialog works with the keyboard and passes axe in the ${theme} theme`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem('kb-chat.theme', value),
      theme,
    );
    await page.goto('/');
    const panel = await sidebar(page);
    const opener = panel.getByRole('button', { name: '+ Novo acervo' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
    await expect(dialog.getByRole('textbox', { name: 'Nome' })).toBeFocused();
    await page.keyboard.type('Teclado');
    await expect(dialog.getByText('teclado', { exact: true })).toBeVisible();
    const serious = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

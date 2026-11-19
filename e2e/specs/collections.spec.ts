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
import {
  activeCollection,
  startNewCollection,
  collectionBySlug,
  collectionButtons,
  collectionTitles,
} from './shell-helpers.js';

/** KBC-048: collections and sub-collections created on the screen (ADR 0028). */

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function sidebar(page: Page): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  if (!desktop(page) && !(await drawer.isVisible()))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Sua biblioteca' })
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
  await startNewCollection(page);
  const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(name);
  if (inside)
    await dialog
      .getByRole('combobox', { name: 'Dentro de' })
      .selectOption({ label: inside });
  const startedAt = Date.now();
  await dialog.getByRole('button', { name: 'Criar acervo' }).click();
  await expect(dialog).toBeHidden();
  await expect(activeCollection(await sidebar(page))).toContainText(name);
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
  const side = await sidebar(member);
  const texts = await collectionTitles(side);
  const at = texts.findIndex((text) => text.startsWith(parent));
  expect(at).toBeGreaterThanOrEqual(0);
  // Right under its parent, indented as a sub-collection (v2: Sua biblioteca's list).
  expect(texts[at + 1]).toBe('Palavra do Mestre');
  await expect(side.locator('li.collection').nth(at + 1)).toHaveClass(/child/);
  await member.context().close();
});

test('AC-6: renaming keeps the address and the selection', async ({ page }) => {
  const member = await aCreator(page);
  const name = uniqueName('Antigo');
  await create(member, name);
  const panel = await sidebar(member);
  await panel.getByRole('button', { name: 'Editar acervo' }).click();
  const dialog = member.getByRole('dialog', { name: 'Editar acervo' });
  await expect(dialog.getByText(slugOf(name), { exact: true })).toBeVisible();
  const renamed = `${name} novo`;
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(renamed);
  await member.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const active = activeCollection(await sidebar(member));
  await expect(active).toHaveAttribute('data-slug', slugOf(name));
  await expect(active).toContainText(renamed);
  await member.context().close();
});

test('AC-7: a name already taken is refused in the dialog', async ({
  page,
}) => {
  const member = await aCreator(page);
  const name = uniqueName('Repetido');
  await create(member, name);
  // v2 (KBC-125): "+ Criar" › "Novo acervo".
  await startNewCollection(member);
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
  await expect(collectionButtons(panel).first()).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Novo acervo', exact: true }),
  ).toHaveCount(0);
  // "+ Criar" offers a conversation only (the phone's Menu has its row instead).
  if (desktop(member)) {
    await panel.getByRole('button', { name: 'Criar', exact: true }).click();
    await expect(
      member.getByRole('menuitem', { name: 'Nova conversa' }),
    ).toBeVisible();
    await expect(
      member.getByRole('menuitem', { name: 'Novo acervo' }),
    ).toHaveCount(0);
    await member.keyboard.press('Escape');
  } else {
    await expect(
      panel.getByRole('button', { name: 'Nova conversa', exact: true }),
    ).toBeVisible();
  }
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
  const side = await sidebar(member);
  await expect(collectionBySlug(side, slugOf(parent))).toBeDisabled();
  await expect(activeCollection(side)).toContainText('Filho');
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
    // v2 (KBC-125): "+ Criar" › "Novo acervo" on desktop, the Menu's entry on a phone.
    const opener = desktop(page)
      ? panel.getByRole('button', { name: 'Criar', exact: true })
      : panel.getByRole('button', { name: 'Novo acervo', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    if (desktop(page)) {
      await expect(
        page.getByRole('menuitem', { name: 'Nova conversa' }),
      ).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(
        page.getByRole('menuitem', { name: 'Novo acervo' }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
    }
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

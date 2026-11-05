import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { makeMp3, uniqueTag, useTheme } from './media-helpers.js';

/** KBC-049: free authors per collection, with a main author (ADR 0030). */

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

interface Udv {
  readonly name: string;
  readonly slug: string;
  readonly sub: string;
}

/** A new "UDV" with its "Palavra do Mestre", made by the owner (unique per test). */
async function aUdv(owner: APIRequestContext): Promise<Udv> {
  const name = `Zz UDV ${uniqueTag()}`;
  const created = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: name },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { slug } = (await created.json()) as { slug: string };
  const child = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: 'Palavra do Mestre', parent: slug },
  });
  expect(child.status(), await child.text()).toBe(201);
  return { name, slug, sub: ((await child.json()) as { slug: string }).slug };
}

const authorsUrl = (topic: string) =>
  `/api/v1/topics/${encodeURIComponent(topic)}/authors`;

/** A member who sees the UDV, with the given features, on the media page. */
async function memberOnMedia(
  page: Page,
  udv: Udv,
  features: string[],
): Promise<Page> {
  const owner = await ownerApi();
  const email = uniqueEmail('autora');
  await invite(owner, email, { topics: [udv.slug], features });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  if (!desktop(member))
    await member.getByRole('button', { name: 'Menu', exact: true }).click();
  await member.getByRole('link', { name: 'Mídia' }).click();
  await expect(
    member.getByRole('heading', { name: new RegExp(`Mídia — ${udv.name}`) }),
  ).toBeVisible();
  return member;
}

async function openUpload(page: Page) {
  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  return page.getByRole('dialog', { name: 'Enviar áudio' });
}

test('AC-1: typing "Mestre Gabriel" registers him and the audio shows his badge', async ({
  page,
}) => {
  const owner = await ownerApi();
  const udv = await aUdv(owner);
  const member = await memberOnMedia(page, udv, [
    'search',
    'media',
    'media-upload',
  ]);
  const dialog = await openUpload(member);
  const title = `Sessão ${uniqueTag()}`;
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(makeMp3(title.replace(/\s+/g, '_'), 3));
  const field = dialog.getByRole('combobox', { name: 'Autor' });
  await field.fill('Mestre Gabriel');
  await dialog
    .getByRole('option', { name: 'Cadastrar «Mestre Gabriel»' })
    .click();
  await expect(field).toHaveValue('Mestre Gabriel');
  await dialog.getByRole('button', { name: 'Enviar' }).click();
  await expect(dialog).toBeHidden();

  const row = member.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByText('Mestre Gabriel')).toBeVisible();
  const authors = await owner.get(authorsUrl(udv.slug));
  expect(await authors.json()).toEqual({
    items: [{ slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false }],
  });
  await member.context().close();
  await owner.dispose();
});

test("AC-3: in a sub-collection the suggestions are the parent's, the main author first", async ({
  page,
}) => {
  const owner = await ownerApi();
  const udv = await aUdv(owner);
  for (const name of ['Ana Souza', 'Mestre Gabriel'])
    await owner.post(authorsUrl(udv.slug), { headers: CSRF, data: { name } });
  await owner.patch(`/api/v1/topics/${encodeURIComponent(udv.slug)}`, {
    headers: CSRF,
    data: { mainAuthor: 'mestre-gabriel' },
  });
  const member = await memberOnMedia(page, udv, [
    'search',
    'media',
    'media-upload',
  ]);
  const dialog = await openUpload(member);
  await dialog
    .getByRole('combobox', { name: 'Acervo' })
    .selectOption({ value: udv.sub });
  const field = dialog.getByRole('combobox', { name: 'Autor' });
  await field.focus();
  await member.keyboard.press('ArrowDown');

  const options = dialog
    .getByRole('listbox', { name: 'Autores do acervo' })
    .getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('Mestre Gabriel');
  await expect(options.first()).toContainText('✦');
  await expect(options.nth(1)).toContainText('Ana Souza');
  // ↑ from anywhere in a list of two lands on the last one.
  await member.keyboard.press('ArrowUp');
  await member.keyboard.press('Enter');
  await expect(field).toHaveValue('Ana Souza');
  // Escape closes only the list; the next one closes the panel.
  await member.keyboard.press('ArrowDown');
  await member.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await member.context().close();
  await owner.dispose();
});

test('AC-4: someone who may not upload there gets 403 registering an author', async ({
  page,
}) => {
  const owner = await ownerApi();
  const udv = await aUdv(owner);
  const member = await memberOnMedia(page, udv, ['search', 'media']);
  const refused = await member.request.post(authorsUrl(udv.slug), {
    headers: CSRF,
    data: { name: 'Mestre Gabriel' },
  });
  expect(refused.status()).toBe(403);
  await expect(
    member.getByRole('button', { name: 'Enviar áudio' }),
  ).toHaveCount(0);
  await member.context().close();
  await owner.dispose();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-6: the "Autor" combobox and the badges pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    const owner = await ownerApi();
    const udv = await aUdv(owner);
    await owner.post(authorsUrl(udv.slug), {
      headers: CSRF,
      data: { name: 'Mestre Gabriel' },
    });
    await owner.patch(`/api/v1/topics/${encodeURIComponent(udv.slug)}`, {
      headers: CSRF,
      data: { mainAuthor: 'mestre-gabriel' },
    });
    const member = await memberOnMedia(page, udv, [
      'search',
      'media',
      'media-upload',
    ]);
    const dialog = await openUpload(member);
    const field = dialog.getByRole('combobox', { name: 'Autor' });
    await field.fill('Mestre');
    await expect(field).toHaveAttribute('aria-expanded', 'true');
    await member.keyboard.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', /.+/);

    const serious = (
      await new AxeBuilder({ page: member }).analyze()
    ).violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious).toEqual([]);
    await member.context().close();
    await owner.dispose();
  });
}

/** The sidebar, or the phone's menu holding it. */
async function sidebar(page: Page): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  if (!desktop(page) && !(await drawer.isVisible()))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : drawer;
}

/** "Editar acervo" of `slug`, choosing its main author by name, checked with axe. */
async function chooseMainAuthor(page: Page, slug: string, name: string) {
  const panel = await sidebar(page);
  await panel
    .getByRole('combobox', { name: 'Acervo', exact: true })
    .selectOption({ value: slug });
  const again = await sidebar(page);
  await again.getByRole('button', { name: 'Editar acervo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar acervo' });
  const select = dialog.getByRole('combobox', { name: 'Autor principal' });
  await expect(select.locator('option', { hasText: name })).toHaveCount(1);
  const serious = (
    await new AxeBuilder({ page }).include('dialog').analyze()
  ).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(serious).toEqual([]);
  await select.selectOption({ label: name });
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  if (!desktop(page)) await page.keyboard.press('Escape');
}

test('FR-2: the owner chooses the main author in "Editar acervo" and the badges follow', async ({
  page,
}) => {
  // Only this test's own collection changes: the search "Autoria" labels are proven by the
  // filter bar's component tests, never on a shared fixture collection (TE-18).
  const owner = await ownerApi();
  const udv = await aUdv(owner);
  await owner.post(authorsUrl(udv.slug), {
    headers: CSRF,
    data: { name: 'Mestre Gabriel' },
  });
  const title = `Sessão ${uniqueTag()}`;
  await owner.post(`/api/v1/topics/${encodeURIComponent(udv.slug)}/media`, {
    headers: CSRF,
    data: { title, author: 'mestre-gabriel', fileName: 'a.mp3', bytes: 10 },
  });
  await page.goto('/');
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();

  await chooseMainAuthor(page, udv.slug, 'Mestre Gabriel');
  // Masters have every feature, so the sidebar leads to the library; it holds every
  // collection's media, in pages, so the collection's filter shows this test's own.
  await (await sidebar(page)).getByRole('link', { name: 'Biblioteca' }).click();
  await expect(
    page.getByRole('heading', { name: 'Biblioteca', level: 2 }),
  ).toBeVisible();
  await page.goto(`/biblioteca?acervo=${encodeURIComponent(udv.slug)}`);
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row.locator('.authorship-badge')).toHaveText(
    /✦\s*Mestre Gabriel/,
  );
  const saved = await owner.get('/api/v1/topics');
  expect(
    (
      (await saved.json()) as { items: { slug: string; mainAuthor: unknown }[] }
    ).items.find((one) => one.slug === udv.slug)?.mainAuthor,
  ).toEqual({ slug: 'mestre-gabriel', name: 'Mestre Gabriel' });
  await owner.dispose();
});

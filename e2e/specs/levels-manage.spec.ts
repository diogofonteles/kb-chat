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

/**
 * KBC-108 (ADR 0036 §10, §11, screens.md T24): the master deletes a level choosing where its
 * content and its people go, moves a level after the server counts who gains and loses, reads
 * "Histórico de níveis" a page at a time, and takes every level away by typing the
 * collection's name; the member then sees everything. Each project has its own collection
 * (`zz-gestao-<project>`, apps/api/src/e2e/server.ts): one test per project, its steps in order.
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

/** A press as the device makes it: a tap on the phone, a click on the desktop. */
async function press(page: Page, target: Locator): Promise<void> {
  if (desktop(page)) await target.click();
  else await target.tap();
}

async function noViolations(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

/** QS < CI < CDC by the API, "Orvalho do Meio" at CI, "Orvalho Velado" at CDC. */
async function scaleOf(owner: APIRequestContext, slug: string) {
  for (const code of ['QS', 'CI', 'CDC']) {
    const created = await owner.post(`/api/v1/topics/${slug}/levels`, {
      data: { code },
      headers: CSRF,
    });
    expect(created.status(), await created.text()).toBe(201);
  }
  for (const [file, level] of [
    ['medio', 'ci'],
    ['velado', 'cdc'],
  ] as const) {
    const placed = await owner.put(
      `/api/v1/topics/${slug}/documents/raw%2F${file}.md/level`,
      { data: { level }, headers: CSRF },
    );
    expect(placed.status(), await placed.text()).toBe(200);
  }
}

/** Renames QS back and forth: enough lines for the history to need a second page. */
async function manyChanges(owner: APIRequestContext, slug: string) {
  for (let n = 0; n < 12; n += 1) {
    const renamed = await owner.patch(`/api/v1/topics/${slug}/levels/qs`, {
      data: { description: `Quadro ${n}` },
      headers: CSRF,
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
  }
}

/** "Aluno" at CI (KBC-109): deleting CI leaves it naming a level that no longer exists. */
async function profileAtCi(owner: APIRequestContext, slug: string) {
  const name = `Aluno ${slug} ${Date.now().toString(36)}`;
  const created = await owner.post('/api/v1/invite-profiles', {
    data: {
      name,
      preset: {
        topics: [slug],
        features: ['search'],
        levels: { [slug]: 'ci' },
      },
    },
    headers: CSRF,
  });
  expect(created.status(), await created.text()).toBe(201);
  return name;
}

/** KBC-109 on T9: the profile asks for another level, named in the field's note. */
async function seeStaleProfile(page: Page, name: string): Promise<void> {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  const side = desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
  await side.getByRole('button', { name: /Pessoas e permissões/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  const section = dialog.getByRole('region', { name: /Perfis de convite/ });
  await section.getByRole('button', { name: /Perfis de convite/ }).click();
  await section
    .getByRole('button', { name: new RegExp(`Editar.*${name}`) })
    .click();
  await expect(
    section.getByText('O nível CI não existe mais; escolha outro.'),
  ).toBeVisible();
  await shoot(page, 'levels-stale-profile');
  await page.keyboard.press('Escape');
}

/** AC-1, AC-8: the dialog counts what CI holds, its targets before the focused danger button. */
async function deleteCi(
  page: Page,
  owner: APIRequestContext,
  slug: string,
): Promise<void> {
  await press(page, page.getByRole('button', { name: 'Apagar CI' }));
  const dialog = page.getByRole('dialog', { name: 'Apagar o nível CI' });
  await expect(
    dialog.getByText('1 documento e 1 pessoa estão em CI.'),
  ).toBeVisible();
  await expect(dialog.getByText(/^1 perfil de convite usa CI\./)).toBeVisible();
  const content = dialog.getByRole('combobox', {
    name: 'Conteúdo de CI vai para:',
  });
  const people = dialog.getByRole('combobox', {
    name: 'Pessoas em CI vão para:',
  });
  await expect(content).toHaveValue('cdc');
  await expect(people).toHaveValue('qs');
  const confirm = dialog.getByRole('button', { name: 'Apagar CI' });
  await expect(confirm).toBeFocused();
  // R1-2: another master changes the scale while the dialog is open; the dialog counts again.
  const renamed = await owner.patch(`/api/v1/topics/${slug}/levels/cdc`, {
    data: { description: 'Outra aba' },
    headers: CSRF,
  });
  expect(renamed.status(), await renamed.text()).toBe(200);
  await press(page, confirm);
  await expect(
    dialog.getByRole('status').filter({
      hasText:
        'A escala mudou. Contei de novo com a escala de agora: confira antes de confirmar.',
    }),
  ).toBeVisible();
  await expect(confirm).toBeEnabled();
  await expect(confirm).toBeFocused();
  const [peopleBox, confirmBox] = await Promise.all([
    people.boundingBox(),
    confirm.boundingBox(),
  ]);
  expect((peopleBox?.y ?? 0) + (peopleBox?.height ?? 0)).toBeLessThanOrEqual(
    confirmBox?.y ?? 0,
  );
  await noViolations(page, 'app-level-delete-dialog');
  await shoot(page, 'levels-delete');
  await press(page, confirm);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.pill')).toHaveText(['QS', 'CDC']);
  await expect(page.getByText('1 documento · 2 pessoas')).toBeVisible();
  await expect(page.getByText('2 documentos · 0 pessoas')).toBeVisible();
}

/** AC-3: moving CDC to the bottom, after the server says who gains what. */
async function moveCdcUp(page: Page): Promise<void> {
  await press(page, page.getByRole('button', { name: 'Mover para cima: CDC' }));
  await expect(
    page.getByText(
      'Mover CDC para a 1ª posição? 2 pessoas passam a ver 2 itens.',
    ),
  ).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Confirmar' });
  await expect(confirm).toBeFocused();
  await shoot(page, 'levels-move');
  await press(page, confirm);
  await expect(page.locator('.pill')).toHaveText(['CDC', 'QS']);
}

/** AC-5, AC-8: the history pages by touch and filters by one item. */
async function readHistory(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /Histórico de níveis/ });
  await press(page, toggle);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const lines = page.locator('app-levels-history li');
  await expect(lines).toHaveCount(20);
  await expect(page.getByText('Ordem: QS, CDC → CDC, QS')).toBeVisible();
  await expect(
    page.getByText('Apagou CI: conteúdo → CDC, pessoas → QS'),
  ).toBeVisible();
  const more = page.getByRole('button', { name: 'Carregar mais' });
  await more.scrollIntoViewIfNeeded();
  await press(page, more);
  await expect(page.getByText('Criou o nível QS')).toBeVisible();
  await expect(page.getByText('Mudou a descrição de QS').first()).toBeVisible();
  await noViolations(page, 'app-levels-history');
  await shoot(page, 'levels-history');
  await press(
    page,
    page.getByRole('button', { name: 'Só este item: Orvalho do Meio' }).first(),
  );
  await expect(page.getByText('Só: Orvalho do Meio')).toBeVisible();
  await expect(lines).toHaveCount(2);
  await expect(page.getByText('CI → CDC: “Orvalho do Meio”')).toBeVisible();
  await expect(page.getByText('QS → CI: “Orvalho do Meio”')).toBeVisible();
}

/** AC-4: the button waits for the collection's name; then nothing has a level. */
async function clearAll(
  page: Page,
  owner: APIRequestContext,
  { slug, title }: { readonly slug: string; readonly title: string },
): Promise<void> {
  await press(
    page,
    page.getByRole('button', { name: 'Tirar todos os níveis' }),
  );
  const dialog = page.getByRole('dialog', { name: 'Tirar todos os níveis' });
  const name = dialog.getByRole('textbox', {
    name: /Digite o nome do acervo para confirmar/,
  });
  await expect(name).toBeFocused();
  const confirm = dialog.getByRole('button', { name: 'Tirar todos os níveis' });
  await expect(confirm).toBeDisabled();
  await name.fill('outro acervo');
  await expect(confirm).toBeDisabled();
  await name.fill(title.toLowerCase());
  await expect(confirm).toBeEnabled();
  await noViolations(page, 'app-level-delete-dialog');
  await shoot(page, 'levels-clear');
  // QA-r2-2: another master adds a level meanwhile; the dialog counts again, the focus on the name.
  const added = await owner.post(`/api/v1/topics/${slug}/levels`, {
    data: { code: 'MX' },
    headers: CSRF,
  });
  expect(added.status(), await added.text()).toBe(201);
  await press(page, confirm);
  await expect(
    dialog.getByRole('status').filter({ hasText: /Contei de novo/ }),
  ).toBeVisible();
  await expect(name).toBeFocused();
  await expect(confirm).toBeEnabled();
  await expect(name).toBeFocused();
  await press(page, confirm);
  await expect(
    page.getByText(
      'Este acervo não tem níveis. Todos com acesso veem todo o conteúdo.',
    ),
  ).toBeVisible();
}

test('KBC-108 AC-1, AC-3, AC-4, AC-5, AC-8: delete a level, move with its preview, read the history, take every level away', async ({
  page,
  browser,
}, testInfo) => {
  const slug = `zz-gestao-${testInfo.project.name}`;
  const title = `Zz Gestão ${testInfo.project.name}`;
  const owner = await ownerApi();
  const kept = await owner.get(`/api/v1/topics/${slug}/levels`);
  const levels = ((await kept.json()) as { levels: unknown[] }).levels.length;
  test.skip(levels > 0, 'A reused server kept this scale: start a fresh one.');
  await scaleOf(owner, slug);
  const ana = uniqueEmail('gestao-ana');
  const anaId = await invite(owner, ana, {
    topics: [slug],
    features: ['search'],
  });
  const atCi = await owner.patch(`/api/v1/people/${anaId}`, {
    data: { levels: { [slug]: 'ci' } },
    headers: CSRF,
  });
  expect(atCi.status(), await atCi.text()).toBe(200);
  await invite(owner, uniqueEmail('gestao-bia'), {
    topics: [slug],
    features: ['search'],
  });
  await manyChanges(owner, slug);
  const profile = await profileAtCi(owner, slug);

  await page.goto(`/acervos/${slug}/niveis`);
  await expect(page.locator('.pill')).toHaveText(['QS', 'CI', 'CDC']);
  await deleteCi(page, owner, slug);
  await seeStaleProfile(page, profile);
  await page.goto(`/acervos/${slug}/niveis`);
  await moveCdcUp(page);
  await readHistory(page);
  await clearAll(page, owner, { slug, title });

  const member = await pageAs(browser, ana, page.viewportSize());
  await member.goto('/');
  // Without research, the box searches documents (her only mode).
  const box = member.getByLabel('Sua pergunta');
  await box.fill('orvalho');
  // The button, once enabled: an Enter right after the first paint could be lost.
  const go = member.getByRole('button', { name: 'Buscar' });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(member.locator('app-result-card')).toHaveCount(3);
  await member.context().close();
  await owner.dispose();
});

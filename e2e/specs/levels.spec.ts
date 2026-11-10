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
 * KBC-103 (ADR 0036, screens.md T24, T9, T3, T4): a master builds the scale of a collection,
 * places a member, and changes a document's level on the reading panel; the member finds only
 * what is at her level, and (KBC-104) AI research answers her from that level only. Each project has its own
 * collection (`zz-niveis-<project>`, apps/api/src/e2e/server.ts), since a scale changes what
 * everyone sees: one test per project, its steps in order.
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

async function sidebar(page: Page): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  if (!desktop(page) && !(await drawer.isVisible()))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : drawer;
}

async function addLevel(page: Page, code: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Código' });
  await expect(page.getByRole('button', { name: 'Adicionar' })).toBeEnabled();
  await field.fill(code);
  await field.press('Enter');
}

async function searchFor(page: Page, words: string): Promise<void> {
  const box = page.getByLabel('Sua pergunta');
  await box.fill(words);
  await box.press('Enter');
}

const results = (page: Page) => page.locator('app-result-card');

/** T24: the scale QS < CI < CDC, built by keyboard, with one move by touch or click. */
async function buildScale(page: Page, slug: string): Promise<void> {
  await page.goto(`/acervos/${slug}/niveis`);
  await expect(
    page.getByRole('heading', { name: /Níveis de acesso/ }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Este acervo não tem níveis. Todos com acesso veem todo o conteúdo.',
    ),
  ).toBeVisible();
  await shoot(page, 'levels-empty');
  await addLevel(page, 'QS');
  await expect(page.getByText(/Todos os 3 documentos/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar nível' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('3 documentos · 1 pessoa')).toBeVisible();
  await addLevel(page, 'CI');
  await expect(page.locator('.pill')).toHaveText(['QS', 'CI']);
  await addLevel(page, 'ci');
  await expect(page.getByRole('alert')).toHaveText(
    'Já existe um nível com o código CI.',
  );
  await addLevel(page, 'CDC');
  await expect(page.locator('.pill')).toHaveText(['QS', 'CI', 'CDC']);
  await press(page, page.getByRole('button', { name: 'Mover para cima: CDC' }));
  const confirm = page.getByRole('button', { name: 'Confirmar' });
  await expect(confirm).toBeFocused();
  await press(page, confirm);
  await expect(page.getByText('CDC agora é o 2º de 3')).toBeAttached();
  await expect(page.locator('.pill')).toHaveText(['QS', 'CDC', 'CI']);
  await press(
    page,
    page.getByRole('button', { name: 'Mover para baixo: CDC' }),
  );
  await press(page, page.getByRole('button', { name: 'Confirmar' }));
  await expect(page.locator('.pill')).toHaveText(['QS', 'CI', 'CDC']);
  const axe = await new AxeBuilder({ page })
    .include('app-levels-page')
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await shoot(page, 'levels-scale');
}

/** The velado document at CDC, and the member at CI (T9's field is the API's PATCH). */
async function place(
  owner: APIRequestContext,
  slug: string,
  memberId: string,
): Promise<void> {
  const placed = await owner.put(
    `/api/v1/topics/${slug}/documents/raw%2Fvelado.md/level`,
    { data: { level: 'cdc' }, headers: CSRF },
  );
  expect(placed.status(), await placed.text()).toBe(200);
  // The owner's Claude subscription, lent to her, answers with the stub model (server.ts).
  const person = await owner.patch(`/api/v1/people/${memberId}`, {
    data: {
      levels: { [slug]: 'ci' },
      ai: { appAi: 'claude-subscription', subscriptionTermsAccepted: true },
    },
    headers: CSRF,
  });
  expect(person.status(), await person.text()).toBe(200);
}

/** T9: the member's "Nível em <acervo>" shows CI. */
async function seePersonLevel(page: Page, title: string, email: string) {
  await page.goto('/');
  const side = await sidebar(page);
  await side.getByRole('button', { name: /Pessoas e permissões/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('button', { name: new RegExp(email) }).click();
  const select = dialog.getByRole('combobox', { name: `Nível em ${title}` });
  await expect(select).toHaveValue('ci');
  await shoot(page, 'levels-person');
  await page.keyboard.press('Escape');
}

/** T3: the master opens the CDC document, sees its badge and moves it to CI. */
async function changeOnPanel(page: Page, slug: string): Promise<void> {
  await page.goto('/');
  const select = (await sidebar(page)).getByRole('combobox', {
    name: 'Acervo',
    exact: true,
  });
  await select.selectOption(slug);
  if (!desktop(page)) await page.keyboard.press('Escape');
  // The master researches here as before (BR-10); the badge is on the search's documents.
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await searchFor(page, 'orvalho');
  await expect(results(page)).toHaveCount(3);
  await page
    .getByRole('button', { name: /Orvalho Velado/ })
    .first()
    .click();
  const panel = page.getByRole('dialog', { name: 'Orvalho Velado' });
  await expect(panel.getByText('Nível: CDC')).toBeVisible();
  await panel.getByRole('button', { name: 'Mudar nível' }).click();
  await panel.getByRole('combobox', { name: 'Nível' }).selectOption('ci');
  await panel.getByRole('button', { name: 'Salvar' }).click();
  await expect(panel.getByText('Nível: CI')).toBeVisible();
  await shoot(page, 'levels-document');
}

/**
 * KBC-104 AC-8: the member at CI asks the AI; the stub searches, reads the first hit and
 * answers from it. Nothing of the CDC document reaches the page: no step, source or answer.
 */
async function researchAtHerLevel(member: Page): Promise<void> {
  await member.goto('/');
  await expect(
    member.getByRole('radio', { name: /Pesquisa com IA/ }),
  ).toBeChecked();
  await expect(
    member.getByText('A pesquisa com IA ainda não está disponível'),
  ).toHaveCount(0);
  await member.getByLabel('Sua pergunta').fill('orvalho');
  await member.getByRole('button', { name: 'Perguntar' }).click();
  const answer = member.locator('app-research-message').last();
  await expect(answer.getByText(/Segundo o acervo/)).toBeVisible();
  // The answer cites a document at her level (the hidden step list repeats the title).
  await expect(
    answer.getByText(/“Orvalho (Aberto|do Meio)” trata do assunto/),
  ).toBeVisible();
  await expect(member.getByText(/Orvalho Velado|velado\.md/)).toHaveCount(0);
  await shoot(member, 'levels-research');
}

test('AC-2, AC-14, AC-17, FR-11, KBC-104 AC-8: the scale on T24, the member at CI researching, a level changed on T3', async ({
  page,
  browser,
}, testInfo) => {
  const slug = `zz-niveis-${testInfo.project.name}`;
  const title = `Zz Níveis ${testInfo.project.name}`;
  const owner = await ownerApi();
  const scale = await owner.get(`/api/v1/topics/${slug}/levels`);
  const kept = ((await scale.json()) as { levels: unknown[] }).levels.length;
  test.skip(kept > 0, 'A reused server kept this scale: start a fresh one.');
  const email = uniqueEmail('nivel');
  const memberId = await invite(owner, email, {
    topics: [slug],
    features: ['search', 'research'],
  });

  await buildScale(page, slug);
  await place(owner, slug, memberId);
  await seePersonLevel(page, title, email);

  const member = await pageAs(browser, email, page.viewportSize());
  await researchAtHerLevel(member);
  await member.getByRole('radio', { name: 'Buscar documentos' }).check();
  await searchFor(member, 'orvalho');
  await expect(results(member)).toHaveCount(2);
  await expect(member.getByText('Orvalho Velado')).toHaveCount(0);
  await expect(member.getByText(/Nível/)).toHaveCount(0);

  await changeOnPanel(page, slug);
  await searchFor(member, 'orvalho velado');
  await expect(member.getByText('Orvalho Velado').first()).toBeVisible();
  await member.context().close();
  await owner.dispose();
});

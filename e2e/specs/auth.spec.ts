import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';

/**
 * KBC-010: Google sign-in (faked, see fixtures.ts) and permissions per person, at 1440 and
 * 390 (one project each).
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function sidebar(page: Page): Promise<Locator> {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
}

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

test.describe('signed out', () => {
  test.use({ signedInAs: null });

  test('AC-1: without a session the web asks to sign in with Google and the API answers 401', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page).toHaveTitle('Nova Alexandria');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Suas conversas e configurações ficam no servidor da Nova Alexandria.',
      ),
    ).toBeVisible();
    expect((await page.request.get('/api/v1/topics')).status()).toBe(401);
    await shoot(page, 'login');

    await page
      .getByRole('button', { name: 'Fazer login com o Google' })
      .click();
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    expect((await page.request.get('/api/v1/topics')).status()).toBe(200);
  });

  test('AC-2: an account that was not invited is told so, may ask for access, and can leave', async ({
    page,
  }) => {
    const stranger = uniqueEmail('stranger');
    await page.addInitScript((email) => {
      (window as Window & { __kbE2eEmail?: string }).__kbE2eEmail = email;
    }, stranger);
    await page.goto('/');

    await page
      .getByRole('button', { name: 'Fazer login com o Google' })
      .click();

    await expect(
      page.getByText('Seu acesso ainda não foi liberado.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Solicitar acesso' }),
    ).toBeVisible();
    await shoot(page, 'not-invited');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toBeVisible();
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  });
});

test('AC-3: a guest with collection A and search sees only A, without the research view', async ({
  browser,
  page,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('guest');
  await invite(owner, email, { topics: ['hermetismo'], features: ['search'] });
  const guest = await pageAs(browser, email, page.viewportSize());

  await guest.goto('/');

  await expect(
    guest.getByRole('heading', { level: 1, name: /Hermetismo/ }),
  ).toBeVisible();
  await expect(
    guest.getByRole('radio', { name: /Pesquisa com IA/ }),
  ).toHaveCount(0);
  const side = await sidebar(guest);
  const topics = side.getByLabel('Acervo');
  await expect(topics.locator('option')).toHaveCount(1);
  await expect(topics.locator('option')).toContainText('Hermetismo');
  await expect(
    side.getByRole('button', { name: 'Pessoas e permissões' }),
  ).toHaveCount(0);
  await expect(side.getByText(email)).toBeVisible();
  const hidden = await guest.request.post('/api/v1/topics/alquimia/searches', {
    data: { q: 'ouro' },
    headers: CSRF,
  });
  expect(hidden.status()).toBe(404);
  await guest.context().close();
  await owner.dispose();
});

test('AC-4: revoking a guest sends their next call back to the login screen', async ({
  browser,
  page,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('revoked');
  const id = await invite(owner, email, { topics: ['hermetismo'] });
  const guest = await pageAs(browser, email, page.viewportSize());
  await guest.goto('/');
  await expect(guest.getByLabel('Sua pergunta')).toBeVisible();

  expect(
    (await owner.delete(`/api/v1/people/${id}`, { headers: CSRF })).status(),
  ).toBe(204);
  // The next call answers 401; the app's own next call sends it back to sign in (any
  // background call may get there first, so the page is reloaded to make it certain).
  expect((await guest.request.get('/api/v1/topics')).status()).toBe(401);
  await guest.reload();

  await expect(
    guest.getByRole('button', { name: 'Fazer login com o Google' }),
  ).toBeVisible();
  await guest.context().close();
  await owner.dispose();
});

test('AC-5: each person sees only their own history', async ({
  browser,
  page,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('history');
  await invite(owner, email, { topics: ['hermetismo'] });
  const guest = await pageAs(browser, email, page.viewportSize());
  const tag = randomUUID().slice(0, 8);
  const save = (api: typeof owner, title: string) => {
    const id = randomUUID();
    const at = new Date().toISOString();
    return api.put(`/api/v1/conversations/${id}`, {
      headers: CSRF,
      data: {
        kind: 'search',
        id,
        topic: 'hermetismo',
        title,
        createdAt: at,
        updatedAt: at,
        asks: [
          {
            question: title,
            mode: 'all',
            filters: { concepts: [], genres: [], depths: [], relevances: [] },
            total: 1,
          },
        ],
      },
    });
  };
  expect((await save(page.request, `${tag} do dono`)).status()).toBe(200);
  expect((await save(guest.request, `${tag} do convidado`)).status()).toBe(200);

  await page.goto('/');
  await guest.goto('/');

  const mine = await sidebar(page);
  await expect(mine.getByText(`${tag} do dono`)).toBeVisible();
  await expect(mine.getByText(`${tag} do convidado`)).toHaveCount(0);
  const theirs = await sidebar(guest);
  await expect(theirs.getByText(`${tag} do convidado`)).toBeVisible();
  await expect(theirs.getByText(`${tag} do dono`)).toHaveCount(0);
  await guest.context().close();
  await owner.dispose();
});

test('a master grants collections and features on "Pessoas e permissões"', async ({
  browser,
  page,
}) => {
  const email = uniqueEmail('granted');
  await page.goto('/');
  const side = await sidebar(page);
  await side.getByRole('button', { name: 'Pessoas e permissões' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(
    dialog.getByRole('heading', { name: 'Pessoas e permissões' }),
  ).toBeVisible();

  await dialog.getByLabel('Convidar por e-mail').fill(email);
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  await expect(dialog.getByRole('status').first()).toContainText(
    `Convite enviado para ${email}.`,
  );
  await dialog.getByRole('checkbox', { name: 'Hermetismo' }).check();
  await expect(dialog.getByText('Salvo.')).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Pesquisa com IA' }).check();
  await expect(
    dialog.getByRole('checkbox', { name: 'Pesquisa com IA' }),
  ).toBeChecked();
  await shoot(page, 'people');

  const guest = await pageAs(browser, email, page.viewportSize());
  await guest.goto('/');
  await expect(
    guest.getByRole('radio', { name: /Pesquisa com IA/ }),
  ).toBeVisible();
  await guest.context().close();
});

test('AC-7: with two masters one demotes the other, then cannot demote themselves', async ({
  page,
}, testInfo) => {
  // One test walks both widths in turn: the master count is shared by the whole run.
  test.skip(testInfo.project.name !== 'desktop', 'runs both widths itself');
  const owner = await ownerApi();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const second = uniqueEmail('master');
    await invite(owner, second, { role: 'master' });
    await page.goto('/');
    const side = await sidebar(page);
    await side.getByRole('button', { name: 'Pessoas e permissões' }).click();
    const dialog = page.getByRole('dialog', { name: 'Configurações' });

    await dialog.getByRole('button', { name: new RegExp(second) }).click();
    await dialog.getByRole('button', { name: 'Remover master' }).click();
    await expect(dialog.getByText('Salvo.')).toBeVisible();
    await dialog.getByRole('button', { name: new RegExp(second) }).click();
    await dialog.getByRole('button', { name: new RegExp(OWNER_EMAIL) }).click();
    await dialog.getByRole('button', { name: 'Remover master' }).click();

    await expect(
      dialog.getByText('Deve restar ao menos um master.'),
    ).toBeVisible();
    await shoot(page, 'last-master');
  }
  await owner.dispose();
});

test('"Sair" ends the session and returns to the login screen', async ({
  browser,
  page,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('leaving');
  await invite(owner, email, { topics: ['hermetismo'] });
  const guest = await pageAs(browser, email, page.viewportSize());
  await guest.goto('/');

  const side = await sidebar(guest);
  await side.getByRole('button', { name: 'Sair' }).click();

  await expect(
    guest.getByRole('button', { name: 'Fazer login com o Google' }),
  ).toBeVisible();
  expect((await guest.request.get('/api/v1/me')).status()).toBe(401);
  await guest.context().close();
  await owner.dispose();
});

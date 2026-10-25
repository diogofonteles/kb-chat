import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  CSRF,
  codeSentTo,
  expect,
  fakeGoogle,
  ownerApi,
  pageAs,
  sentCount,
  test,
  uniqueEmail,
} from './fixtures.js';

/**
 * KBC-014: ask for access (form or Google), a master decides, and an approved person signs
 * in with a one-time code. Codes are read from the E2E server's outbox. 1440 and 390.
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

/** The owner's "Pessoas e permissões", opened from the sidebar entry with the badge. */
async function openPeople(owner: Page): Promise<Locator> {
  await owner.goto('/');
  const side = await sidebar(owner);
  const entry = side.getByRole('button', { name: /Pessoas e permissões/ });
  await expect(entry).toHaveAccessibleName(/solicita(ção|ções) pendentes?/);
  await entry.click();
  return owner.getByRole('dialog', { name: 'Configurações' });
}

const requestItem = (dialog: Locator, email: string) =>
  dialog.getByRole('listitem').filter({ hasText: email });

/** A Google account that was not invited asks for access through the API (its ticket). */
async function googleRequest(api: APIRequestContext, email: string) {
  const token = await api.post('/api/e2e/token', {
    data: { email },
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  const refused = await api.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  expect(refused.status()).toBe(403);
  const { ticket } = (await refused.json()).error.details;
  const created = await api.post('/api/v1/access-requests/google', {
    data: { ticket },
    headers: CSRF,
  });
  expect(created.status(), await created.text()).toBe(201);
}

test.describe('without a session', () => {
  test.use({ signedInAs: null });

  test('sign-up without Google → pending → a master approves → the person signs in with a code', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('signup');
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Pedir acesso sem conta Google' })
      .click();
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Nome', { exact: true }).fill('Ana');
    await page.getByLabel('Sobrenome').fill('Lima');
    await page.getByLabel('Celular').fill('(81) 99999-0000');
    await shoot(page, 'signup-form');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(
      page.getByText('Se o e-mail puder ser usado, enviamos um código'),
    ).toBeVisible();
    await page.getByLabel('Código').fill(await codeSentTo(page.request, email));
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText(/Solicitação enviada/)).toBeVisible();
    await shoot(page, 'signup-done');

    const owner = await pageAs(
      browser,
      'owner@kb-chat.test',
      page.viewportSize(),
    );
    const dialog = await openPeople(owner);
    const item = requestItem(dialog, email);
    await expect(item).toContainText('Ana Lima');
    await expect(item).toContainText('+5581999990000');
    await shoot(owner, 'requests');
    await item.getByRole('button', { name: 'Aprovar' }).click();
    await expect(
      dialog.getByText('Acesso aprovado. Escolha os acervos de Ana Lima.'),
    ).toBeVisible();
    await expect(
      dialog.getByRole('checkbox', { name: 'Buscar documentos' }),
    ).toBeChecked();
    await owner.context().close();

    // The approval email arrives after the reply; the sign-in code comes next.
    await expect.poll(() => sentCount(page.request, email)).toBe(2);
    await page.goto('/');
    await page.getByRole('button', { name: 'Entrar com código' }).click();
    await page.getByLabel('Seu e-mail').fill(email);
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await shoot(page, 'code-sent');
    const code = await codeSentTo(page.request, email, 2);
    await page.getByLabel('Código').fill(code);
    await page.getByRole('button', { name: 'Entrar' }).click();
    // Approved with the invite defaults: signed in, search on no collection yet (BR-6).
    await expect(
      page.getByText('Nenhum acervo foi liberado para você ainda'),
    ).toBeVisible();
    await shoot(page, 'signed-in-with-code');
    const side = await sidebar(page);
    await expect(side.getByText(email)).toBeVisible();
  });

  test('Google without an invite → "Solicitar acesso" → pending for the masters', async ({
    page,
  }) => {
    const stranger = uniqueEmail('google-request');
    await page.addInitScript((email) => {
      (window as Window & { __kbE2eEmail?: string }).__kbE2eEmail = email;
    }, stranger);
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Fazer login com o Google' })
      .click();
    await page.getByRole('button', { name: 'Solicitar acesso' }).click();
    await page.getByLabel('Celular (opcional)').fill('81988887777');
    await shoot(page, 'google-request');
    await page.getByRole('button', { name: 'Enviar solicitação' }).click();
    await expect(page.getByText(/Solicitação enviada/)).toBeVisible();

    const owner = await ownerApi();
    const list = await owner.get('/api/v1/access-requests');
    const items = (await list.json()).items as {
      email: string;
      source: string;
      phone: string;
    }[];
    expect(items.find((r) => r.email === stranger)).toMatchObject({
      source: 'google',
      phone: '+5581988887777',
    });
    await owner.dispose();

    await page.reload();
    await page
      .getByRole('button', { name: 'Fazer login com o Google' })
      .click();
    await expect(page.getByRole('alert')).toHaveText(
      'Sua solicitação está em análise.',
    );
  });
});

test('a master refuses a request, and the person is told when to ask again', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('refused');
  const owner = await ownerApi();
  await googleRequest(owner, email);
  await owner.dispose();

  const dialog = await openPeople(page);
  const item = requestItem(dialog, email);
  await item.getByRole('button', { name: 'Recusar' }).click();
  await expect(
    item.getByText(/só poderá pedir de novo em 24 horas/),
  ).toBeVisible();
  await item.getByRole('button', { name: 'Recusar' }).click();
  await expect(requestItem(dialog, email)).toHaveCount(0);

  const context = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const person = await context.newPage();
  await fakeGoogle(person);
  await person.addInitScript((who) => {
    (window as Window & { __kbE2eEmail?: string }).__kbE2eEmail = who;
  }, email);
  await person.goto('/');
  await person
    .getByRole('button', { name: 'Fazer login com o Google' })
    .click();
  await expect(person.getByRole('alert')).toContainText(
    'Sua solicitação foi recusada. Você pode pedir de novo a partir de',
  );
  await expect(
    person.getByRole('button', { name: 'Solicitar acesso' }),
  ).toHaveCount(0);
  await shoot(person, 'refused');
  await context.close();
});

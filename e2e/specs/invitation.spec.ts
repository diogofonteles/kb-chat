import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  expect,
  pageAs,
  sentCount,
  test,
  uniqueEmail,
  WEB_ORIGIN,
} from './fixtures.js';

/**
 * KBC-026: inviting sends an e-mail (read from the E2E server's outbox, never sent), the
 * list shows the invitation until the first sign-in, and a resend is limited. 1440 and 390.
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
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

async function inviteFrom(
  dialog: Locator,
  email: string,
  options: { skipEmail?: boolean } = {},
): Promise<void> {
  await dialog.getByLabel('Convidar por e-mail').fill(email);
  if (options.skipEmail)
    await dialog
      .getByRole('checkbox', { name: 'Não enviar e-mail de convite' })
      .check();
  await dialog.getByRole('button', { name: 'Convidar' }).click();
}

const personRow = (dialog: Locator, email: string) =>
  dialog.getByRole('button', { name: new RegExp(email) });

async function mailTo(api: APIRequestContext, to: string) {
  const response = await api.get(
    `/api/e2e/outbox?to=${encodeURIComponent(to)}`,
  );
  return (
    (await response.json()) as { items: { subject: string; text: string }[] }
  ).items;
}

test('AC-1, AC-4: inviting e-mails the person, the row says when, and a resend right away is limited', async ({
  page,
}) => {
  const email = uniqueEmail('invited');
  const dialog = await openPeople(page);

  await inviteFrom(dialog, email);

  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: `Convite enviado para ${email}.` }),
  ).toBeVisible();
  await expect(personRow(dialog, email)).toContainText('Convite enviado em');
  const [mail, ...more] = await mailTo(page.request, email);
  expect(more).toEqual([]);
  expect(mail?.subject).toBe('Você foi convidado para a Nova Alexandria');
  expect(mail?.text).toContain('convidou você para a Nova Alexandria');
  expect(mail?.text).toContain(WEB_ORIGIN);
  expect(mail?.text).toContain('"Entrar com código"');
  await shoot(page, 'invitation-sent');

  await dialog.getByRole('button', { name: 'Reenviar convite' }).click();

  await expect(
    dialog.getByRole('status').filter({
      hasText:
        'Este convite foi enviado há pouco. Você pode reenviar a partir de',
    }),
  ).toBeVisible();
  expect(await sentCount(page.request, email)).toBe(1);
  await shoot(page, 'invitation-limited');
});

test('AC-2, AC-3: "Não enviar e-mail" sends nothing; "Enviar convite" sends later; "Ativo" after the first sign-in', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('quiet');
  const dialog = await openPeople(page);

  await inviteFrom(dialog, email, { skipEmail: true });

  await expect(
    dialog.getByRole('status').filter({
      hasText: `Convite criado sem e-mail. ${email} já pode entrar`,
    }),
  ).toBeVisible();
  await expect(personRow(dialog, email)).toContainText('Ainda não entrou');
  expect(await sentCount(page.request, email)).toBe(0);
  await expect(
    dialog.getByRole('checkbox', { name: 'Não enviar e-mail de convite' }),
  ).not.toBeChecked();
  await shoot(page, 'invitation-skipped');

  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: `Convite enviado para ${email}.` }),
  ).toBeVisible();
  expect(await sentCount(page.request, email)).toBe(1);

  const guest = await pageAs(browser, email, page.viewportSize());
  await guest.goto('/');
  await guest.context().close();
  const reopened = await openPeople(page);
  await expect(personRow(reopened, email)).toContainText('Ativo');
  await personRow(reopened, email).click();
  await expect(
    reopened.getByRole('button', { name: /enviar convite/i }),
  ).toHaveCount(0);
  await shoot(page, 'invitation-active');
});

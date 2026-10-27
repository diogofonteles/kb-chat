import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  expect,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';

/**
 * KBC-028: an invitation profile sets the person up at once (collections, features, the app
 * AI and the initial preferences); "Configurar agora" adjusts one invitation without
 * touching the profile; "Aplicar perfil" works on someone already there. 1440 and 390 px.
 *
 * The profiles here are never the default one: the E2E server is shared by parallel specs.
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
/**
 * Validation screenshots (KBC_SHOTS): the part that changed, and no sideways scroll on the
 * page or inside the dialog (its section tabs scroll sideways on a phone by design).
 */
async function shoot(page: Page, name: string, part?: Locator): Promise<void> {
  if (!shots) return;
  const path = `${shots}/${name}-${page.viewportSize()?.width}.png`;
  await (part ?? page).screenshot({ path });
  const sideways = await page.evaluate(() =>
    [
      document.documentElement,
      ...Array.from(
        document.querySelectorAll<HTMLElement>('dialog, dialog *:not(nav)'),
      ),
    ]
      .filter((el) => {
        const overflow = getComputedStyle(el).overflowX;
        return (
          el.scrollWidth > el.clientWidth + 1 &&
          overflow !== 'visible' &&
          overflow !== 'hidden'
        );
      })
      .map((el) => `${el.tagName}.${el.className}`),
  );
  expect(sideways, `${name}: no horizontal scroll`).toEqual([]);
}

const profiles = (dialog: Locator) =>
  dialog.getByRole('region', { name: /Perfis de convite/ });

/** Creates the "Aluno" profile of AC-1 under a unique name, through the screen. */
async function createAluno(dialog: Locator, name: string): Promise<void> {
  const section = profiles(dialog);
  await section.getByRole('button', { name: /Perfis de convite/ }).click();
  await section.getByRole('button', { name: 'Novo perfil' }).click();
  await section.getByLabel('Nome do perfil').fill(name);
  await section.getByRole('checkbox', { name: 'Hermetismo' }).check();
  await section.getByRole('checkbox', { name: 'Pesquisa com IA' }).check();
  await section.getByLabel('Qual IA atende a pessoa').selectOption('house');
  await section.getByLabel('Pesquisas por dia (vazio = padrão)').fill('3');
  await section.getByLabel('Pesquisas por dia (vazio = padrão)').blur();
  await section.getByLabel('Acervo padrão').selectOption('hermetismo');
  await section.getByLabel('Visão inicial').selectOption('research');
  await section.getByLabel('Perfil de pesquisa').selectOption('fast');
  await section.getByLabel('Tema').selectOption('dark');
  await expectAccessible(section.page());
  await section.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(section.getByText(`Perfil "${name}" salvo.`)).toBeVisible();
}

/** WCAG 2.2 AA in the dialog as it stands (NFR-1). */
async function expectAccessible(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);
}

async function removeProfile(dialog: Locator, name: string): Promise<void> {
  const section = profiles(dialog);
  await section.getByRole('button', { name: `Apagar ${name}` }).click();
  await section.getByRole('button', { name: 'Apagar', exact: true }).click();
  await expect(section.getByText(`Perfil "${name}" apagado.`)).toBeVisible();
}

const inviteForm = (dialog: Locator) => dialog.locator('form.invite');

const personRow = (dialog: Locator, email: string) =>
  dialog.getByRole('button', { name: new RegExp(email) });

test('AC-1: inviting with a profile sets up access, AI and the first Settings', async ({
  page,
  browser,
}) => {
  const name = `Aluno ${Date.now().toString(36)}`;
  const email = uniqueEmail('aluno');
  const dialog = await openPeople(page);
  await createAluno(dialog, name);
  await shoot(page, 'invite-profiles', profiles(dialog));

  await inviteForm(dialog)
    .locator('select[name="profile"]')
    .selectOption({ label: name });
  await expect(dialog.getByText(`começa com o perfil "${name}"`)).toBeVisible();
  await dialog.getByLabel('Convidar por e-mail').fill(email);
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: `Perfil: ${name}.` }),
  ).toBeVisible();
  await expect(personRow(dialog, email)).toContainText('Hermetismo');
  await expect(personRow(dialog, email)).toContainText('IA: Plano da casa');
  await dialog.getByText('Histórico da IA').click();
  await expect(
    dialog.getByText(/owner@kb-chat\.test · Plano da casa/),
  ).toBeVisible();
  await shoot(
    page,
    'invite-with-profile',
    dialog.getByRole('listitem').filter({ hasText: email }),
  );

  const guest = await pageAs(browser, email, page.viewportSize());
  await guest.goto('/');
  await expect(guest.locator('html')).toHaveAttribute('data-theme', 'dark');
  if (!desktop(guest))
    await guest.getByRole('button', { name: 'Menu' }).click();
  await guest.getByRole('button', { name: 'Configurações' }).click();
  const settings = guest.getByRole('dialog', { name: 'Configurações' });
  await settings.getByRole('button', { name: 'Preferências' }).click();
  await expect(settings.getByLabel('Tema')).toHaveValue('dark');
  await expect(settings.getByLabel('Acervo padrão')).toHaveValue('hermetismo');
  await shoot(guest, 'invited-first-settings', settings);
  await guest.context().close();

  await removeProfile(dialog, name);
});

test('AC-2, AC-4: "Configurar agora" adjusts one invitation; "Aplicar perfil" on someone there', async ({
  page,
}) => {
  const name = `Aluno ${Date.now().toString(36)}b`;
  const adjusted = uniqueEmail('ajustado');
  const existing = uniqueEmail('existente');
  const dialog = await openPeople(page);
  await createAluno(dialog, name);

  // A plain invitation first: the person who will get the profile later.
  await inviteForm(dialog)
    .locator('select[name="profile"]')
    .selectOption('none');
  await dialog.getByLabel('Convidar por e-mail').fill(existing);
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  await expect(personRow(dialog, existing)).toContainText('Nenhum acervo');

  await inviteForm(dialog)
    .locator('select[name="profile"]')
    .selectOption({ label: name });
  await dialog.getByRole('button', { name: 'Configurar agora' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Descartar configuração' }),
  ).toHaveAttribute('aria-expanded', 'true');
  const preset = dialog.locator('#invite-preset');
  await expect(
    preset.getByLabel('Pesquisas por dia (vazio = padrão)'),
  ).toHaveValue('3');
  await preset.getByLabel('Pesquisas por dia (vazio = padrão)').fill('7');
  await preset.getByLabel('Pesquisas por dia (vazio = padrão)').blur();
  await preset.getByLabel('Tema').selectOption('light');
  await expectAccessible(page);
  await shoot(page, 'invite-configure-now', inviteForm(dialog));
  await dialog.getByLabel('Convidar por e-mail').fill(adjusted);
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: 'Perfil: configuração própria.' }),
  ).toBeVisible();
  await expect(personRow(dialog, adjusted)).toContainText('Hermetismo');
  await expect(
    dialog.getByLabel('Pesquisas por dia (vazio = padrão)'),
  ).toHaveValue('7');

  // The profile kept its own numbers.
  const section = profiles(dialog);
  await section.getByRole('button', { name: `Editar ${name}` }).click();
  await expect(
    section.getByLabel('Pesquisas por dia (vazio = padrão)'),
  ).toHaveValue('3');
  await section.getByRole('button', { name: 'Cancelar' }).click();

  await personRow(dialog, existing).click();
  await dialog
    .locator('app-person-editor select[name="applyProfile"]')
    .selectOption({ label: name });
  await dialog.getByRole('button', { name: 'Aplicar perfil' }).click();
  await expect(
    dialog.getByText(`Aplicar o perfil "${name}" a ${existing}?`),
  ).toBeVisible();
  await expectAccessible(page);
  await shoot(
    page,
    'apply-profile-confirm',
    dialog.locator('app-person-editor'),
  );
  await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: `Perfil "${name}" aplicado a ${existing}.` }),
  ).toBeVisible();
  await expect(personRow(dialog, existing)).toContainText('Hermetismo');
  await expect(personRow(dialog, existing)).toContainText('IA: Plano da casa');

  await removeProfile(dialog, name);
});

test('KBC-031 AC-5: the owner lends his subscription in the invitation, after the terms', async ({
  page,
}) => {
  const email = uniqueEmail('cedida');
  // No spec makes a profile the default: "Configurar agora" opens the plain preset.
  const dialog = await openPeople(page);
  await dialog.getByRole('button', { name: 'Configurar agora' }).click();
  const preset = dialog.locator('#invite-preset');
  await preset
    .getByLabel('Qual IA atende a pessoa')
    .selectOption({ label: 'Claude do administrador' });
  const confirm = preset.getByRole('group', {
    name: 'Ceder a assinatura do Claude a quem você está convidando?',
  });
  await expect(confirm).toContainText('Os termos da Anthropic não permitem');
  await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await dialog.getByLabel('Convidar por e-mail').fill(email);
  // The invitation waits for the terms.
  const send = dialog.getByRole('button', { name: 'Convidar' });
  await expect(send).toBeDisabled();
  await expect(send).toHaveAccessibleDescription(
    'Confirme ou cancele a cessão da assinatura em “IA da aplicação” para convidar.',
  );
  await expectAccessible(page);
  await shoot(page, 'invite-lend-confirm', inviteForm(dialog));
  await confirm.getByRole('button', { name: 'Ceder assim mesmo' }).click();
  await expect(
    preset
      .getByRole('status')
      .filter({ hasText: 'Termos da assinatura do Claude confirmados' }),
  ).toBeVisible();
  await shoot(page, 'invite-lend-confirmed', inviteForm(dialog));
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: 'Perfil: configuração própria.' }),
  ).toBeVisible();
  await expect(personRow(dialog, email)).toContainText(
    'IA: Claude do administrador',
  );
  const owner = await ownerApi();
  const people = await (await owner.get('/api/v1/people')).json();
  const invited = people.items.find(
    (person: { email: string }) => person.email === email,
  );
  expect(invited.ai.history.at(-1)).toMatchObject({
    appAi: 'claude-subscription',
    by: OWNER_EMAIL,
    termsAccepted: true,
  });
  await owner.patch(`/api/v1/people/${invited.id}`, {
    data: { ai: { appAi: 'none' } },
    headers: CSRF,
  });
  await owner.dispose();
});

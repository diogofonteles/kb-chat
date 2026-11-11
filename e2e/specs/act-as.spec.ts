import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';

/** KBC-060: a master acts as a person, audited (ADR 0027). */

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openSettings(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** A member who saw only "hermetismo", already signed in once (their name is known). */
async function aMember(page: Page) {
  const email = uniqueEmail('ana');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research'],
  });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  await skipWizard(member);
  return { email, member };
}

/** A first visit may open the setup wizard; "Pular" closes it when it is there. */
async function skipWizard(page: Page) {
  const skip = page.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function startActingAs(page: Page, email: string, reason: string) {
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await settings.getByRole('button', { name: new RegExp(email) }).click();
  await settings.getByRole('button', { name: 'Ver como', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Ver como / });
  await dialog.getByRole('textbox', { name: 'Motivo' }).fill(reason);
  await dialog.getByRole('button', { name: 'Ver como esta pessoa' }).click();
}

test('AC-1, AC-2, AC-6, AC-8: the owner sees the app as a member, changes a setting for her and goes back; both see it recorded', async ({
  page,
}) => {
  const { email, member } = await aMember(page);
  await startActingAs(page, email, 'não vê os marcadores');

  const band = page.getByText(/Você está vendo como/).first();
  await expect(band).toBeVisible();
  await expect(page.getByText(/termina em (29|30):\d\d/)).toBeVisible();
  await skipWizard(page);
  // Her view: only her collection, and no "Pessoas e permissões".
  const settings = await openSettings(page);
  await expect(
    settings.getByRole('button', { name: 'Pessoas e permissões' }),
  ).toHaveCount(0);
  await settings.getByRole('button', { name: 'Acessos à sua conta' }).click();
  await expect(settings.getByText('(agora)')).toBeVisible();
  await settings.getByRole('button', { name: 'Preferências' }).click();
  await settings
    .getByRole('combobox', { name: 'Tema' })
    .selectOption({ label: 'Escuro' });
  await expect(settings.getByText('Salvo automaticamente.')).toBeVisible();
  await page.keyboard.press('Escape');
  // On a phone the menu drawer, like any modal, covers the band until it closes.
  if (!desktop(page)) await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Voltar para a minha conta' }).click();
  await expect(band).toHaveCount(0);
  const own = await openSettings(page);
  await own.getByRole('button', { name: 'Auditoria do Ver como' }).click();
  await own
    .getByRole('searchbox', { name: 'Filtrar por pessoa ou master' })
    .fill(email);
  await expect(own.getByText(/Alterou/).first()).toBeVisible();
  await expect(own.getByText('PUT /api/v1/settings')).toBeVisible();

  // Ana sees who entered, why and what changed.
  await member.reload();
  const hers = await openSettings(member);
  await hers.getByRole('button', { name: 'Acessos à sua conta' }).click();
  await expect(hers.getByText('não vê os marcadores')).toBeVisible();
  await expect(hers.getByText(/1 alteração/)).toBeVisible();
  await member.context().close();
});

test('AC-5: what only the person may do is refused while acting', async ({
  page,
}) => {
  const { email, member } = await aMember(page);
  await member.context().close();
  await startActingAs(page, email, 'conferir a IA');
  await expect(page.getByText(/Você está vendo como/).first()).toBeVisible();
  const refused = await page.request.put('/api/v1/settings', {
    headers: { 'x-requested-with': 'kb-chat' },
    data: { ai: { keys: { openrouter: 'sk-or-fake-key-for-e2e' } } },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('NOT_WHILE_ACTING');
  await page.getByRole('button', { name: 'Voltar para a minha conta' }).click();
});

test('AC-9: the dialog needs a reason, and Esc gives the focus back', async ({
  page,
}) => {
  const { email, member } = await aMember(page);
  await member.context().close();
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await settings.getByRole('button', { name: new RegExp(email) }).click();
  const actAs = settings.getByRole('button', { name: 'Ver como', exact: true });
  await actAs.click();
  const dialog = page.getByRole('dialog', { name: /^Ver como / });
  await dialog.getByRole('button', { name: 'Ver como esta pessoa' }).click();
  await expect(dialog.getByText(/Escreva o motivo/)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Motivo' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(actAs).toBeFocused();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-10: the band and the dialog pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem('kb-chat.theme', value),
      theme,
    );
    const { email, member } = await aMember(page);
    await member.context().close();
    await page.goto('/');
    const settings = await openSettings(page);
    await settings
      .getByRole('button', { name: 'Pessoas e permissões' })
      .click();
    await settings.getByRole('button', { name: new RegExp(email) }).click();
    await settings
      .getByRole('button', { name: 'Ver como', exact: true })
      .click();
    const serious = async () =>
      (await new AxeBuilder({ page }).analyze()).violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? ''),
      );
    expect(await serious()).toEqual([]);
    const dialog = page.getByRole('dialog', { name: /^Ver como / });
    await dialog.getByRole('textbox', { name: 'Motivo' }).fill('axe');
    await dialog.getByRole('button', { name: 'Ver como esta pessoa' }).click();
    await expect(page.getByText(/Você está vendo como/).first()).toBeVisible();
    await skipWizard(page);
    expect(await serious()).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    await page
      .getByRole('button', { name: 'Voltar para a minha conta' })
      .click();
  });
}

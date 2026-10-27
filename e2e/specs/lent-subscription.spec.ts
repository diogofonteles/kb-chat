import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
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
 * KBC-024: the owner lends his Claude subscription to one person, after the terms; the person
 * sees it is temporary. The E2E server's lent subscription answers with the stub (no CLI).
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openSettings(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

test('AC-1, AC-2, AC-5: the owner lends his subscription after the terms; the person is told and researches', async ({
  browser,
  page,
}) => {
  const email = uniqueEmail('lent');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research', 'own-ai-settings'],
  });

  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await dialog.getByRole('button', { name: new RegExp(email) }).click();
  const fieldset = dialog.getByRole('group', { name: 'IA da aplicação' });
  await fieldset
    .getByLabel('Qual IA atende esta pessoa')
    .selectOption({ label: 'Claude do administrador' });
  const terms = fieldset.getByRole('group', {
    name: 'Ceder a assinatura do Claude a esta pessoa?',
  });
  await expect(terms).toContainText('Os termos da Anthropic não permitem');
  await expect(
    fieldset.getByRole('button', { name: 'Cancelar' }),
  ).toBeFocused();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);
  await noHorizontalScroll(page);
  await expect(
    fieldset.getByText(/não está disponível agora no servidor/),
  ).toHaveCount(0);
  await fieldset.getByRole('button', { name: 'Ceder assim mesmo' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Salvo.' }),
  ).toBeVisible();
  await dialog.getByText('Histórico da IA').click();
  await expect(dialog.getByText(/termos confirmados/)).toBeVisible();

  const person = await pageAs(browser, email, page.viewportSize());
  await person.goto('/');
  await person.getByRole('button', { name: 'Pular' }).click();
  await expect(person.getByRole('dialog')).toHaveCount(0);
  const settings = await openSettings(person);
  await expect(
    settings.getByText(
      'Você está usando temporariamente a IA da aplicação (assinatura do Claude do administrador).',
    ),
  ).toBeVisible();
  await settings.getByRole('button', { name: 'Configurar a minha IA' }).click();
  await expect(
    settings.getByRole('radio', { name: /^OpenRouter/ }),
  ).toBeFocused();
  await person.waitForFunction(() => document.getAnimations().length === 0);
  const personAxe = await new AxeBuilder({ page: person })
    .include('dialog')
    .analyze();
  expect(personAxe.violations).toEqual([]);
  await noHorizontalScroll(person);
  await settings.getByRole('button', { name: 'Fechar configurações' }).click();
  // On a phone, closing Settings goes back to the menu it was opened from.
  if (!desktop(person))
    await person.getByRole('button', { name: 'Fechar menu' }).click();
  await person.getByLabel('Sua pergunta').fill('o que é o mentalismo?');
  await person.getByRole('button', { name: 'Perguntar' }).click();
  const answer = person.locator('app-research-message').last();
  await expect(
    answer.getByText('Incluído na assinatura do administrador'),
  ).toBeVisible();
  await expect(
    answer.getByText('IA da aplicação (assinatura do Claude do administrador)'),
  ).toBeVisible();
  await person.context().close();
  await owner.dispose();
});

test('AC-6: lending to the selected people asks for the terms first, never as the default', async ({
  page,
}) => {
  const email = uniqueEmail('lent-bulk');
  const owner = await ownerApi();
  const id = await invite(owner, email);
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await dialog.getByLabel(`Selecionar ${email}`).check();
  const bar = dialog.getByRole('group', {
    name: 'IA da aplicação para várias pessoas',
  });
  await bar
    .getByRole('combobox')
    .selectOption({ label: 'Claude do administrador' });
  await expect(
    bar.getByRole('checkbox', { name: /próximos convidados/ }),
  ).toBeDisabled();
  await bar
    .getByRole('button', { name: 'Aplicar às selecionadas (1)' })
    .click();
  await expect(
    bar.getByRole('group', {
      name: 'Ceder a assinatura do Claude a 1 pessoa selecionada?',
    }),
  ).toContainText('Os termos da Anthropic não permitem');
  await bar.getByRole('button', { name: 'Ceder assim mesmo' }).click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: 'IA da aplicação atualizada para 1 pessoa(s).' }),
  ).toBeVisible();
  const person = (await (await owner.get('/api/v1/people')).json()) as {
    items: {
      id: string;
      ai: { appAi: string; history: { termsAccepted?: boolean }[] };
    }[];
  };
  const ai = person.items.find((item) => item.id === id)?.ai;
  expect(ai?.appAi).toBe('claude-subscription');
  expect(ai?.history.at(-1)?.termsAccepted).toBe(true);
  await owner.dispose();
});

test('QA F-3: a person without their own AI settings is told in Preferências', async ({
  browser,
  page,
}) => {
  const email = uniqueEmail('lent-plain');
  const owner = await ownerApi();
  const id = await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research'],
  });
  const lent = await owner.patch(`/api/v1/people/${id}`, {
    data: {
      ai: { appAi: 'claude-subscription', subscriptionTermsAccepted: true },
    },
    headers: CSRF,
  });
  expect(lent.status()).toBe(200);
  const person = await pageAs(browser, email, page.viewportSize());
  await person.goto('/');
  const settings = await openSettings(person);
  await expect(
    settings.getByText(
      'Você está usando temporariamente a IA da aplicação (assinatura do Claude do administrador).',
    ),
  ).toBeVisible();
  await expect(
    settings.getByRole('button', { name: 'Configurar a minha IA' }),
  ).toHaveCount(0);
  await person.context().close();
  await owner.dispose();
});

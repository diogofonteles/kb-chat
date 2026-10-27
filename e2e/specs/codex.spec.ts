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
 * KBC-027 against the E2E server's real Codex runner (with the fake Codex): a master turns
 * the ChatGPT subscription on and the owner lends it to one person, who researches through
 * the runner. Turning it on is idempotent (desktop and phone share the server); nothing turns
 * it off. The owner's own use is in the API tests: his settings are shared by every spec.
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openSettings(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function ask(page: Page) {
  if (!desktop(page))
    await page.getByRole('button', { name: 'Fechar menu' }).click();
  await page.getByLabel('Sua pergunta').fill('o que é o ritmo?');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  return page.locator('app-research-message').last();
}

test('AC-4: a master turns Codex on, with its login on the server', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'IA da aplicação' }).click();
  const block = dialog.getByRole('region', {
    name: 'Assinatura do ChatGPT (Codex)',
  });
  await expect(block.getByText('Logado no servidor.')).toBeVisible();
  const toggle = block.getByRole('checkbox', {
    name: 'Ligar a assinatura do ChatGPT (Codex)',
  });
  if (!(await toggle.isChecked())) await toggle.check();
  await expect(toggle).toBeChecked();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);
});

test('AC-5: the owner lends the ChatGPT subscription to one person', async ({
  browser,
  page,
}) => {
  const owner = await ownerApi();
  await owner.put('/api/v1/house-ai', {
    data: { codexEnabled: true },
    headers: CSRF,
  });
  const email = uniqueEmail('lent-gpt');
  const id = await invite(owner, email, {
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
    .selectOption({ label: 'ChatGPT do administrador' });
  await expect(
    fieldset.getByRole('group', {
      name: 'Ceder a assinatura do ChatGPT a esta pessoa?',
    }),
  ).toContainText('Os termos da OpenAI não permitem');
  await fieldset.getByRole('button', { name: 'Ceder assim mesmo' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Salvo.' }),
  ).toBeVisible();

  const person = await pageAs(browser, email, page.viewportSize());
  await person.goto('/');
  await person.getByRole('button', { name: 'Pular' }).click();
  await expect(person.getByRole('dialog')).toHaveCount(0);
  const settings = await openSettings(person);
  await expect(
    settings.getByText(
      'Você está usando temporariamente a IA da aplicação (assinatura do ChatGPT do administrador).',
    ),
  ).toBeVisible();
  await settings.getByRole('button', { name: 'Fechar configurações' }).click();
  const answer = await ask(person);
  await expect(answer.getByText(/Tudo flui/)).toBeVisible();
  await expect(
    answer.getByText(
      'IA da aplicação (assinatura do ChatGPT do administrador)',
    ),
  ).toBeVisible();
  await person.context().close();
  await owner.patch(`/api/v1/people/${id}`, {
    data: { ai: { appAi: 'none' } },
    headers: CSRF,
  });
  await owner.dispose();
});

test('KBC-031 AC-2: once on, the owner picks the ChatGPT card and tests it through the runner', async ({
  page,
}) => {
  const owner = await ownerApi();
  await owner.put('/api/v1/house-ai', {
    data: { codexEnabled: true },
    headers: CSRF,
  });
  await owner.dispose();
  await page.goto('/');
  const dialog = await openSettings(page);
  const card = dialog.getByRole('radio', { name: /Assinatura do ChatGPT/ });
  await expect(card).toBeEnabled();
  await expect(dialog.getByText(/Instale o Codex CLI/)).toHaveCount(0);
  await expect(dialog.getByText(/KB_CHAT_CODEX=on/)).toHaveCount(0);
  // Picked, not saved: the owner's settings are shared by every spec.
  await card.check();
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(dialog.getByText(/Conexão funcionando/)).toBeVisible();
});

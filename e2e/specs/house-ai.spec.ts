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

/**
 * "IA da aplicação" (KBC-022) against the E2E server's fake OpenRouter: the consent page
 * approves at once, the chat answers "Resposta do plano da casa." from the first free model.
 * The house default is "Nenhuma" there, so only the person a spec lends it to uses it.
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openSettings(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('AC-1, AC-8, AC-4: a master connects OpenRouter, lends the house plan to one person, who researches for free', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  let dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'IA da aplicação' }).click();
  await dialog.getByRole('button', { name: 'Conectar OpenRouter' }).click();
  // OpenRouter (faked) approves and sends the master back: the section reopens by itself.
  await page.waitForURL((url) => !url.search.includes('openrouter='));
  dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog.getByText('Conta conectada.')).toBeVisible();
  await expect(dialog.getByText('••••wxyz')).toBeVisible();
  await expect(
    dialog.getByText(/Pedidos gratuitos hoje: 0 de 1000/),
  ).toBeVisible();
  await expect(dialog.getByText('Fake Large (free)')).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);

  const email = uniqueEmail('house');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research'],
  });
  await dialog.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await dialog.getByRole('button', { name: new RegExp(email) }).click();
  await dialog
    .getByLabel('Qual IA atende esta pessoa')
    .selectOption({ label: 'Plano da casa (OpenRouter da aplicação)' });
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Salvo.' }),
  ).toBeVisible();

  const person = await pageAs(browser, email, page.viewportSize());
  await person.goto('/');
  await person.getByLabel('Sua pergunta').fill('o que é o mentalismo?');
  await person.getByRole('button', { name: 'Perguntar' }).click();
  const answer = person.locator('app-research-message').last();
  await expect(answer.getByText('Resposta do plano da casa.')).toBeVisible();
  await expect(
    answer.getByText('Respondido por fake/large:free'),
  ).toBeVisible();
  await expect(answer.getByText('Gratuito', { exact: true })).toBeVisible();
  await expect(answer.getByText('Pesquisas restantes hoje: 4')).toBeVisible();
  await person.context().close();
  await owner.dispose();
});

test('AC-5: the quota spent offers the person their own AI', async ({
  browser,
  page,
}) => {
  const email = uniqueEmail('quota');
  const owner = await ownerApi();
  const id = await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research', 'own-ai-settings'],
  });
  await owner.put('/api/v1/house-ai', {
    data: { key: 'sk-or-v1-house-valid' },
    headers: { 'x-requested-with': 'kb-chat' },
  });
  await owner.patch(`/api/v1/people/${id}`, {
    data: { ai: { appAi: 'house', dailyResearches: 0 } },
    headers: { 'x-requested-with': 'kb-chat' },
  });
  const person = await pageAs(browser, email, page.viewportSize());
  await person.goto('/');
  // With "Configurações de IA próprias" the first-run wizard opens first.
  await person.getByRole('button', { name: 'Pular' }).click();
  await expect(person.getByRole('dialog')).toHaveCount(0);
  await person.getByLabel('Sua pergunta').fill('o que é o mentalismo?');
  await person.getByRole('button', { name: 'Perguntar' }).click();
  await expect(
    person
      .getByRole('alert')
      .filter({ hasText: 'Suas pesquisas com IA de hoje acabaram' }),
  ).toBeVisible();
  await person.getByRole('button', { name: 'Conectar a minha IA' }).click();
  const dialog = person.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog.getByText('Quem atende você agora')).toBeVisible();
  await expect(
    dialog.getByText('IA da aplicação (cedida pelo administrador)'),
  ).toBeVisible();
  await person.context().close();
  await owner.dispose();
});

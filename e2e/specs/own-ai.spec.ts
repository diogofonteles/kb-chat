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
 * "Sua IA" (KBC-023) against the E2E server's fakes: OpenRouter (consent approved at once,
 * free models) and Gemini (a key ending in "valid" is accepted).
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openSettings(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** A person with research and their own AI settings; the first-run wizard skipped. */
async function personWithOwnAi(
  browser: Parameters<typeof pageAs>[0],
  page: Page,
) {
  const email = uniqueEmail('own');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research', 'own-ai-settings'],
  });
  await owner.dispose();
  const person = await pageAs(browser, email, page.viewportSize());
  await person.goto('/');
  await person.getByRole('button', { name: 'Pular' }).click();
  await expect(person.getByRole('dialog')).toHaveCount(0);
  return person;
}

async function research(page: Page) {
  if (!desktop(page) && (await page.getByRole('dialog').count()) > 0)
    await page.getByRole('button', { name: 'Fechar menu' }).click();
  await page.getByLabel('Sua pergunta').fill('o que é o mentalismo?');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  return page.locator('app-research-message').last();
}

test('AC-1, AC-2: connects one’s own OpenRouter in one click and answers for free', async ({
  browser,
  page,
}) => {
  const person = await personWithOwnAi(browser, page);
  const dialog = await openSettings(person);
  await dialog.getByRole('radio', { name: /^OpenRouter/ }).check();
  await expect(
    dialog.getByRole('region', { name: 'Como configurar' }),
  ).toBeVisible();
  await person.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page: person })
    .include('dialog')
    .analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Conectar OpenRouter' }).click();
  await person.waitForURL((url) => !url.search.includes('openrouter='));
  const back = person.getByRole('dialog', { name: 'Configurações' });
  await expect(back.getByText('Conta conectada.')).toBeVisible();
  await expect(back.getByText('Sua IA')).toBeVisible();
  await expect(back.getByText('Gratuito (modelos gratuitos).')).toBeVisible();
  await back.getByRole('button', { name: 'Fechar configurações' }).click();
  const answer = await research(person);
  await expect(answer.getByText('Resposta do plano da casa.')).toBeVisible();
  await expect(answer.getByText('Sua IA', { exact: true })).toBeVisible();
  await expect(answer.getByText('Gratuito', { exact: true })).toBeVisible();
  await person.context().close();
});

test('AC-4, AC-7: guides the free Google key, tests it and shows the last test', async ({
  browser,
  page,
}) => {
  const person = await personWithOwnAi(browser, page);
  const dialog = await openSettings(person);
  await dialog.getByRole('radio', { name: /Gemini/ }).check();
  await expect(
    dialog.getByText(/o Google pode usar as perguntas/),
  ).toBeVisible();
  await dialog.getByLabel(/Chave da API/).fill('AIza-wrong');
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(
    dialog.getByText('A chave não foi aceita pelo provedor.'),
  ).toBeVisible();
  await dialog.getByLabel(/Chave da API/).fill('AIza-e2e-valid');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog.getByText('Salvo.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(dialog.getByText(/Conexão funcionando/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar configurações' }).click();
  const answer = await research(person);
  await expect(answer.getByText('Resposta do Gemini.')).toBeVisible();
  await expect(answer.getByText('Gratuito', { exact: true })).toBeVisible();
  const again = await openSettings(person);
  await expect(again.getByText(/Último teste: funcionando/)).toBeVisible();
  await person.context().close();
});

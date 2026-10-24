import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** The ⚙ entry: in the side panel on desktop, in the "Menu" drawer on phones (FR-6). */
async function openSettings(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const SETTINGS_VIEW = {
  preferences: {
    searchMode: 'all',
    theme: 'auto',
    defaultView: 'research',
    researchProfile: 'fast',
  },
  ai: { provider: null, models: {}, keys: {}, dailyCapUsd: 1 },
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('FR-6: ⚙ Configurações opens over the conversation and closes back to it', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
  const dialog = await openSettings(page);
  await expect(
    dialog.getByRole('radio', { name: /Assinatura do Claude/ }),
  ).toBeVisible();
  // The dialog fades in: contrast is measured once the animation is over.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Fechar configurações' }).click();
  await expect(dialog).toBeHidden();
  if (!desktop(page))
    await page.getByRole('button', { name: 'Fechar menu' }).click();
  await expect(page.locator('app-result-message .question')).toHaveText([
    /ritmo/,
  ]);
});

test('AC-3: without Claude Code the subscription is disabled, with how to install it', async ({
  page,
}) => {
  const dialog = await openSettings(page);
  await expect(
    dialog.getByRole('radio', { name: /Assinatura do Claude/ }),
  ).toBeDisabled();
  await expect(dialog.getByText(/Instale o Claude Code/)).toBeVisible();
});

test('AC-2: a saved key shows only its last 4 characters and can be removed', async ({
  page,
}) => {
  // Desktop and phone run in parallel on one server: each uses its own provider's key.
  const [provider, name, last4] = desktop(page)
    ? (['openai', /OpenAI API/, 'dsk1'] as const)
    : (['anthropic', /Anthropic API/, 'mob1'] as const);
  const key = `sk-e2e-secret-${last4}`;
  // Only the key: the provider answering the other specs stays as it is.
  const saved = await page.request.put('/api/v1/settings', {
    data: { ai: { keys: { [provider]: key } } },
  });
  expect(await saved.text()).not.toContain(key);
  await page.reload();
  const dialog = await openSettings(page);
  await dialog.getByRole('radio', { name }).check();
  await expect(dialog.getByText(`••••${last4}`)).toBeVisible();
  await expect(dialog.getByLabel(/Chave da API/)).toHaveValue('');
  expect(await page.content()).not.toContain(key);
  await dialog.getByRole('button', { name: 'Remover' }).click();
  await expect(dialog.getByText(`••••${last4}`)).toBeHidden();
});

test('AC-5: an invalid key gets "A chave não foi aceita pelo provedor"', async ({
  page,
}) => {
  const dialog = await openSettings(page);
  await dialog.getByRole('radio', { name: /OpenAI API/ }).check();
  await dialog.getByLabel(/Chave da API/).fill('sk-e2e-wrong-key');
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(
    dialog.getByText('A chave não foi aceita pelo provedor.'),
  ).toBeVisible();
});

test('KBC-011: each provider shows a fast and a deep model with its defaults', async ({
  page,
}) => {
  const dialog = await openSettings(page);
  await dialog.getByRole('radio', { name: /OpenRouter/ }).check();
  await expect(dialog.getByLabel('Modelo rápido')).toHaveAttribute(
    'placeholder',
    'Padrão: deepseek/deepseek-v4-flash',
  );
  await expect(dialog.getByLabel('Modelo profundo')).toHaveAttribute(
    'placeholder',
    'Padrão: deepseek/deepseek-v4-pro',
  );
  await dialog.getByRole('radio', { name: /Anthropic API/ }).check();
  await expect(dialog.getByLabel('Modelo rápido')).toHaveAttribute(
    'placeholder',
    'Padrão: claude-sonnet-5-5',
  );
});

test('AC-1: the wizard shows on the first run and not again after "Concluir"', async ({
  page,
}) => {
  // The shared E2E server already has settings; this browser sees a first run instead.
  let exists = false;
  let saved: unknown = null;
  await page.route('**/api/v1/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      exists = true;
    }
    await route.fulfill({ json: { exists, ...SETTINGS_VIEW } });
  });
  await page.reload();
  const wizard = page.getByRole('dialog');
  await expect(
    wizard.getByRole('heading', { name: 'Como a IA vai responder?' }),
  ).toBeVisible();
  await expect(wizard.getByText('Passo 1 de 4')).toBeVisible();
  for (let step = 0; step < 3; step += 1)
    await wizard.getByRole('button', { name: 'Continuar' }).click();
  await wizard.getByLabel('Tema').selectOption('dark');
  await wizard.getByRole('button', { name: 'Concluir' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(saved).toMatchObject({ preferences: { theme: 'dark' } });
  await page.reload();
  // The saved default view (research) opens, with the stub provider answering.
  await expect(
    page.getByText('O que você quer pesquisar no acervo?'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: /Como a IA/ })).toBeHidden();
});

test('the default view saved in Settings opens on the next page', async ({
  page,
}) => {
  await page.route('**/api/v1/settings', (route) =>
    route.fulfill({
      json: {
        exists: true,
        ...SETTINGS_VIEW,
        preferences: { ...SETTINGS_VIEW.preferences, defaultView: 'search' },
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole('radio', { name: 'Buscar documentos' }),
  ).toBeChecked();
  await expect(page.getByText('O que você quer estudar hoje?')).toBeVisible();
});

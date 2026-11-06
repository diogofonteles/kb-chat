import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady } from './media-helpers.js';

// KBC-037: "Groq de reserva" in Configurações and "Transcrever com Groq" on an audio. The
// E2E server's Groq is a fake (a key ending in "valid" is accepted): nothing is paid. The
// settings are one row shared by every spec of the run, so no test turns Groq back off.

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openGroq(page: Page): Promise<Locator> {
  await page.goto('/biblioteca');
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('button', { name: 'Groq de reserva' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Groq de reserva' }),
  ).toBeVisible();
  return dialog;
}

const seriousViolations = async (page: Page) =>
  (
    await new AxeBuilder({ page }).include('dialog').analyze()
  ).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

/** Groq connected and "Só quando eu pedir", through the API (as another tab would). */
async function groqOnDemand(owner: APIRequestContext): Promise<void> {
  const tested = await owner.post('/api/v1/media/groq/test', {
    headers: CSRF,
    data: { key: 'gsk_e2e_valid' },
  });
  expect(await tested.json()).toMatchObject({ ok: true });
  const saved = await owner.put('/api/v1/media/groq/mode', {
    headers: CSRF,
    data: { mode: 'manual', idleHours: 12 },
  });
  expect(saved.status()).toBe(200);
}

test('AC-5, AC-7: a master connects Groq, chooses the mode and sees the month, with no serious axe violation', async ({
  page,
}) => {
  const dialog = await openGroq(page);
  await expect(dialog.getByRole('radio', { name: 'Nunca' })).toBeVisible();
  await expect(dialog.getByText(/US\$\s[\d,]+ de US\$\s[\d,]+/)).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  const key = dialog.getByLabel(/chave da API do Groq/i);
  const keyStatus = dialog.getByRole('status').first();
  await key.fill('gsk_e2e_wrong');
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(keyStatus).toContainText('A chave não foi aceita pelo Groq.');

  await key.fill('gsk_e2e_valid');
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(keyStatus).toContainText('Conectado.');
  await expect(key).toHaveValue('');
  await expect(
    dialog.getByText('Chave conectada.', { exact: false }),
  ).toBeVisible();

  await dialog
    .getByRole('radio', { name: /Quando o Mac estiver parado/ })
    .check();
  const hours = dialog.getByLabel('Horas parado');
  await hours.fill('0');
  await expect(
    dialog.getByText('Use um número inteiro de 1 a 168.'),
  ).toBeVisible();
  await hours.fill('24');
  // Back to on demand: another spec may click "Transcrever com Groq" meanwhile.
  await dialog.getByRole('radio', { name: 'Só quando eu pedir' }).check();
  await dialog.getByRole('button', { name: 'Salvar modo' }).click();
  await expect(dialog.getByText('Modo salvo.')).toBeVisible();
  const cap = dialog.getByLabel('Teto mensal (US$)');
  await expect(cap).toBeVisible();
  // An empty cap is no cap: refused at the field, never saved as US$ 0.
  await cap.fill('');
  await dialog.getByRole('button', { name: 'Salvar teto' }).click();
  await expect(
    dialog.getByText('Use um valor de 0 a 1000 dólares.'),
  ).toBeVisible();
  await expect(cap).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('Teto salvo.')).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);
});

test('AC-2: "Transcrever com Groq" sends a waiting audio, and it comes back transcribed by Groq', async ({
  page,
}) => {
  const owner = await ownerApi();
  await groqOnDemand(owner);
  const { id, title } = await uploadReady(owner, {
    title: `Groq ${uniqueTag()}`,
    seconds: 3,
  });
  await owner.dispose();
  await page.goto(`/midia/${id}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const meta = page.locator('app-media-player-page .meta');
  await expect(meta).toContainText('Aguardando o transcritor');

  await page.getByRole('button', { name: 'Transcrever com Groq' }).click();
  const question = page.getByRole('group', { name: /com o Groq agora/ });
  await expect(
    question.getByRole('button', { name: 'Cancelar' }),
  ).toBeFocused();
  await expect(question).toContainText(/US\$\s0,01/);
  await question.getByRole('button', { name: 'Transcrever com Groq' }).click();

  await expect(meta).toContainText(
    /Na fila do Groq|Transcrevendo pelo Groq|Transcrita pelo Groq/,
  );
  await expect(meta).toContainText('Transcrita pelo Groq', { timeout: 60_000 });
  await expect(
    page.getByRole('button', { name: 'Transcrever com Groq' }),
  ).toHaveCount(0);
});

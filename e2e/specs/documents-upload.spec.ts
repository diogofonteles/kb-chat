import type { APIRequestContext, Browser, Page } from '@playwright/test';
import type { Feature } from '@kb-chat/contracts';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageWith,
  test,
  uniqueEmail,
} from './fixtures.js';
import { aCollectionInVault, uniqueTag } from './media-helpers.js';
import { chooseCollectionSlug, library } from './shell-helpers.js';

// KBC-149 (and KBC-148's "Ver original"): a document or a link sent from "+ Criar", followed
// in "Documentos em processamento" up to "Pronto", then read with its original. The Mac is
// the E2E server's fake (`/api/e2e/doc-ingest/run`): a fake kb-map and kb, no model.

const SENDS: Feature[] = ['search', 'media', 'media-upload'];
type Viewport = { width: number; height: number } | null;

async function person(
  browser: Browser,
  viewport: Viewport,
  features: Feature[] = SENDS,
): Promise<{ page: Page; topic: string; owner: APIRequestContext }> {
  const owner = await ownerApi();
  const topic = await aCollectionInVault(owner);
  const email = uniqueEmail('docs');
  await invite(owner, email, { topics: [topic], features });
  const page = await pageWith(browser, email, { viewport });
  await page.goto('/');
  await chooseCollectionSlug(page, topic);
  return { page, topic, owner };
}

async function openSend(page: Page) {
  const side = await library(page);
  await side.getByRole('button', { name: 'Criar', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Enviar documento ou link' })
    .click();
  return page.getByRole('dialog', { name: 'Enviar documento ou link' });
}

const pdf = (tag: string) => ({
  name: `Caibalion ${tag}.pdf`,
  mimeType: 'application/pdf',
  buffer: Buffer.from(`%PDF-1.4 o caibalion ${tag}`),
});

async function runMac(owner: APIRequestContext, topic: string) {
  const ran = await owner.post('/api/e2e/doc-ingest/run', {
    headers: CSRF,
    data: { topic },
  });
  expect(ran.status(), await ran.text()).toBe(200);
}

test('AC-1, AC-3: a PDF goes to "Pronto", opens with "Ver original", and twice is the same', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, topic, owner } = await person(browser, viewport);
  const tag = uniqueTag();
  const file = pdf(tag);

  const dialog = await openSend(page);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByText(file.name)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('send-dialog.png') });
  await dialog
    .getByRole('button', { name: 'Enviar', exact: true })
    .last()
    .click();
  await expect(dialog.getByText('Recebido')).toBeVisible();
  await dialog.getByRole('link', { name: 'Fila de processamento' }).click();

  await expect(
    page.getByRole('heading', { name: 'Documentos em processamento' }),
  ).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: file.name });
  await expect(row.getByText('Recebido')).toBeVisible();

  await runMac(owner, topic);
  await page.reload();
  await expect(row.getByText('Pronto')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('queue-ready.png') });
  await row.getByRole('button', { name: 'Abrir' }).click();
  const original = page.getByRole('link', { name: 'Ver original' });
  await expect(original).toBeVisible();
  const href = await original.getAttribute('href');
  const served = await page.request.get(href ?? '');
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('application/pdf');
  expect((await served.body()).equals(file.buffer)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('document-original.png') });

  // BR-3: the same file again is the document already there.
  await page.goto('/');
  const again = await openSend(page);
  await again.locator('input[type="file"]').setInputFiles(file);
  await again
    .getByRole('button', { name: 'Enviar', exact: true })
    .last()
    .click();
  await expect(
    again.getByText('Este documento já está no acervo'),
  ).toBeVisible();
  await expect(
    again.getByRole('button', { name: 'Abrir documento' }),
  ).toBeVisible();
});

test('AC-4: a link that does not convert fails with why, and nothing enters', async ({
  browser,
  viewport,
}) => {
  const { page, topic, owner } = await person(browser, viewport);
  const url = `https://quebrado.example/${uniqueTag()}`;
  const dialog = await openSend(page);
  await dialog.getByRole('button', { name: 'Link' }).click();
  await dialog.getByLabel('Endereço').fill(url);
  await dialog
    .getByRole('button', { name: 'Enviar', exact: true })
    .last()
    .click();
  await expect(dialog.getByText('Recebido')).toBeVisible();

  await runMac(owner, topic);
  await page.goto('/fila');
  const row = page.getByRole('listitem').filter({ hasText: url });
  await expect(row.getByText('Falhou')).toBeVisible();
  await expect(row.getByText(/Não consegui converter/)).toBeVisible();
  await expect(row.getByRole('button', { name: 'Abrir' })).toHaveCount(0);
});

test('AC-2: Beto without the permission has no "Enviar documento ou link", and the API says 403', async ({
  browser,
  viewport,
}) => {
  const { page, topic } = await person(browser, viewport, ['search', 'media']);
  const side = await library(page);
  await side.getByRole('button', { name: 'Criar', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Nova conversa' }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Enviar documento ou link' }),
  ).toHaveCount(0);
  const refused = await page.request.post(
    `/api/v1/topics/${encodeURIComponent(topic)}/documents`,
    { headers: CSRF, data: { kind: 'url', url: 'https://example.org/x' } },
  );
  expect(refused.status()).toBe(403);
});

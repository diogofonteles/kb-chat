import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  APIRequestContext,
  Browser,
  Locator,
  Page,
} from '@playwright/test';
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
import {
  chooseCollectionSlug,
  desktop,
  library,
  startNewCollection,
} from './shell-helpers.js';

// KBC-149, KBC-184 (and KBC-148's "Ver original"): documents and links sent from "Adicionar
// conteúdo", followed there up to "Pronto", then read with their original. The Mac is the E2E
// server's fake (`/api/e2e/doc-ingest/run`): a fake kb-map and kb, no model.

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

/** The visible way in, at both widths, on the collection in use. */
async function openAdd(page: Page): Promise<Locator> {
  const side = await library(page);
  await side.getByRole('link', { name: 'Adicionar conteúdo' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Adicionar conteúdo' }),
  ).toBeVisible();
  // Alone in the main panel: no conversation's home nor question box beside it.
  await expect(page.getByLabel('Sua pergunta')).toBeHidden();
  await expect(page.locator('app-conversation-home')).toBeHidden();
  return page.locator('app-add-content-page');
}

const FILES = 'input[type="file"]:not(.folder-input)';

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

const processing = (add: Locator, name: string): Locator =>
  add
    .getByRole('region', { name: 'Documentos em processamento' })
    .getByRole('listitem')
    .filter({ hasText: name });

const sentNow = (add: Locator, name: string): Locator =>
  add
    .getByRole('region', { name: 'Enviados agora' })
    .getByRole('listitem')
    .filter({ hasText: name });

test('AC-1, AC-3: files go together to "Pronto", one opens with "Ver original", and twice is the same', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, topic, owner } = await person(browser, viewport);
  const files = [pdf(uniqueTag()), pdf(uniqueTag())] as const;
  const bad = { ...files[0], name: 'programa.exe' };

  const add = await openAdd(page);
  await expect(add.getByRole('combobox', { name: 'Acervo' })).toHaveValue(
    topic,
  );
  await add.locator(FILES).setInputFiles([...files, bad]);
  await expect(add.getByText(/Este tipo de arquivo não entra/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('files-chosen.png') });
  await add.getByRole('button', { name: 'Incluir 2 itens' }).click();
  for (const file of files) {
    await expect(sentNow(add, file.name).getByText('Recebido')).toBeVisible();
    await expect(processing(add, file.name)).toBeVisible();
  }

  await runMac(owner, topic);
  const row = processing(add, files[0].name);
  await expect(row.getByText('Pronto')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ready.png') });
  await row.getByRole('button', { name: 'Abrir' }).click();
  const original = page.getByRole('link', { name: 'Ver original' });
  await expect(original).toBeVisible();
  const served = await page.request.get(
    (await original.getAttribute('href')) ?? '',
  );
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('application/pdf');
  expect((await served.body()).equals(files[0].buffer)).toBe(true);

  // BR-3: the same file again is the document already there, one press away.
  await page.goto(`/adicionar?acervo=${encodeURIComponent(topic)}`);
  await add.locator(FILES).setInputFiles(files[0]);
  await add.getByRole('button', { name: 'Incluir 1 item' }).click();
  const again = sentNow(add, files[0].name);
  await expect(again.getByText('Já está no acervo')).toBeVisible();
  await expect(again.getByRole('button', { name: 'Abrir' })).toBeVisible();
});

test('a whole folder goes, sub-folders too; what cannot is named, and the account closes', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, topic, owner } = await person(browser, viewport);
  const tag = uniqueTag();
  const folder = testInfo.outputPath(`Pasta ${tag}`);
  await mkdir(join(folder, 'sub', 'mais fundo'), { recursive: true });
  const good = [
    'um.pdf',
    join('sub', 'dois.txt'),
    join('sub', 'mais fundo', 'tres.md'),
  ];
  for (const name of good)
    await writeFile(join(folder, name), `texto de ${name} ${tag}`);
  await writeFile(join(folder, 'Thumbs.db'), 'x');
  await writeFile(join(folder, 'programa.exe'), 'x');

  const add = await openAdd(page);
  await add.locator('input.folder-input').setInputFiles(folder);
  await expect(add.getByText('5 arquivos encontrados')).toBeVisible();
  await expect(add.getByText('Não entram (2)')).toBeVisible();
  await expect(add.getByText(/programa\.exe$/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('folder.png') });
  await add.getByRole('button', { name: 'Incluir 3 itens' }).click();
  await expect(add.getByText('Tudo o que você incluiu chegou')).toBeVisible();
  await expect(add.getByText(/3 de 3 enviados/)).toBeVisible();

  await runMac(owner, topic);
  for (const name of ['um.pdf', 'dois.txt', 'tres.md'])
    await expect(processing(add, name).getByText('Pronto')).toBeVisible();

  // The same folder again: nothing is sent twice, and it says so.
  await page.reload();
  await add.locator('input.folder-input').setInputFiles(folder);
  await add.getByRole('button', { name: 'Incluir 3 itens' }).click();
  await expect(add.getByText(/0 de 3 enviados · 3 já estavam/)).toBeVisible();
});

test('AC-4: several links at once; one that does not convert says why, is tried again and taken out', async ({
  browser,
  viewport,
}) => {
  const { page, topic, owner } = await person(browser, viewport);
  const tag = uniqueTag();
  const good = `https://example.org/${tag}`;
  const broken = `https://quebrado.example/${tag}`;
  const add = await openAdd(page);
  await add.getByRole('button', { name: 'Links' }).click();
  await add.getByLabel('Endereços').fill(`${good}\n${broken}\nnão é link`);
  await expect(add.getByText('2 endereços prontos')).toBeVisible();
  await expect(add.getByText(/Não é um endereço: não é link/)).toBeVisible();
  await add.getByRole('button', { name: 'Incluir 2 itens' }).click();
  await expect(processing(add, broken)).toBeVisible();

  await runMac(owner, topic);
  await expect(processing(add, good).getByText('Pronto')).toBeVisible();
  const row = processing(add, broken);
  await expect(row.getByText('Falhou')).toBeVisible();
  await expect(row.getByText(/Não consegui converter/)).toBeVisible();
  await row.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(row.getByText('Recebido')).toBeVisible();
  await row.getByRole('button', { name: /^Tirar .* da lista$/ }).click();
  await expect(row).toHaveCount(0);
});

test('KBC-184: a collection made on the screen takes its content right away', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, owner } = await person(browser, viewport, [
    ...SENDS,
    'collection-create',
  ]);
  const name = `Zz Novo ${uniqueTag()}`;
  await startNewCollection(page);
  const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(name);
  await page.screenshot({ path: testInfo.outputPath('new-collection.png') });
  await dialog
    .getByRole('button', { name: 'Criar e adicionar conteúdo' })
    .click();

  const add = page.locator('app-add-content-page');
  const where = add.getByRole('combobox', { name: 'Acervo' });
  await expect(where.locator('option:checked')).toHaveText(name);
  const topic = await where.inputValue();
  await add.getByRole('button', { name: 'Links' }).click();
  const url = `https://example.org/${uniqueTag()}`;
  await add.getByLabel('Endereços').fill(url);
  await add.getByRole('button', { name: 'Incluir 1 item' }).click();
  await expect(processing(add, url)).toBeVisible();
  await runMac(owner, topic);
  await expect(processing(add, url).getByText('Pronto')).toBeVisible();
});

test('AC-2: Beto without the permission has no "Adicionar conteúdo", nor its page, and the API says 403', async ({
  browser,
  viewport,
}) => {
  const { page, topic } = await person(browser, viewport, ['search', 'media']);
  const side = await library(page);
  await expect(
    side.getByRole('link', { name: 'Adicionar conteúdo' }),
  ).toHaveCount(0);
  await page.goto('/adicionar');
  await expect(page).toHaveURL(/\/$/);
  const refused = await page.request.post(
    `/api/v1/topics/${encodeURIComponent(topic)}/documents`,
    { headers: CSRF, data: { kind: 'url', url: 'https://example.org/x' } },
  );
  expect(refused.status()).toBe(403);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`the page passes axe and fits the width, with fields a phone does not zoom, in the ${theme} theme`, async ({
    browser,
    viewport,
  }, testInfo) => {
    const { page } = await person(browser, viewport);
    await page.addInitScript(
      (value) => localStorage.setItem('kb-chat.theme', value),
      theme,
    );
    await page.reload();
    const add = await openAdd(page);
    for (const way of ['Arquivos', 'Links', 'Áudio e vídeo']) {
      await add.getByRole('button', { name: way, exact: true }).click();
      const serious = (
        await new AxeBuilder({ page }).analyze()
      ).violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? ''),
      );
      expect(serious, way).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${theme}-${way}.png`),
      });
      if (desktop(page)) continue;
      const wide = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(wide, way).toBeLessThanOrEqual(0);
      const sizes = await add
        .locator('select, textarea, input:not([type=file])')
        .evaluateAll((fields) =>
          fields
            // The collection's closed dialog is in the page too: what is seen is measured.
            .filter((one) => one.getClientRects().length > 0)
            .map((one) => Number.parseFloat(getComputedStyle(one).fontSize)),
        );
      expect(Math.min(...sizes, 16), way).toBeGreaterThanOrEqual(16);
    }
  });
}

import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { aCollectionInVault, makeMp3, uniqueTag } from './media-helpers.js';
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

test('KBC-185: the web is searched here, what is picked has its estimate and enters with the rest', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, topic, owner } = await person(browser, viewport);
  const subject = `os sete princípios ${uniqueTag()}`;
  const add = await openAdd(page);
  await add.getByRole('button', { name: 'Pesquisar na web' }).click();
  await add.getByLabel('Assunto').fill(subject);
  await add.getByLabel('Quantidade de fontes').fill('6');
  await add.getByLabel('Autores de referência (opcional)').fill('Hermes');
  await add.getByRole('button', { name: 'Pesquisar', exact: true }).click();
  const all = add.getByRole('checkbox', { name: 'Selecionar todos' });
  await expect(all).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('search-found.png') });

  // Two of them, a text and a video: the estimate follows what is picked.
  await all.click();
  await expect(
    add.getByRole('button', { name: 'Incluir', exact: true }),
  ).toBeDisabled();
  const results = add.getByRole('group', { name: /^Resultados para/ });
  const rowOf = (kind: string) =>
    results
      .getByRole('listitem')
      .filter({ has: page.getByText(kind, { exact: true }) })
      .first();
  // The whole row is the label: a press anywhere on it picks it.
  await rowOf('Texto').locator('label').click();
  await rowOf('Vídeo').locator('label').click();
  const estimate = add.getByRole('region', { name: 'Quanto deve custar' });
  await expect(estimate.getByText('1 página da web')).toBeVisible();
  await expect(estimate.getByText('1 áudio ou vídeo')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('search-picked.png') });
  await add.getByRole('button', { name: 'Incluir 2 itens' }).click();
  await expect(add.getByText(/2 de 2 enviados/)).toBeVisible();
  await expect(results.getByText('Incluído agora')).toHaveCount(2);

  await runMac(owner, topic);
  const states = add
    .getByRole('region', { name: 'Documentos em processamento' })
    .getByRole('listitem');
  await expect(states.filter({ hasText: 'Pronto' })).toHaveCount(1);
  await expect(states.filter({ hasText: 'Transcrevendo' })).toHaveCount(1);
});

test('KBC-186: from a channel only what is chosen enters, and a video file enters by its sound', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, topic, owner } = await person(browser, viewport);
  const tag = uniqueTag().replace(/[^a-z0-9]/gi, '');
  const channel = `https://www.youtube.com/@canal${tag}`;
  const add = await openAdd(page);
  await add.getByRole('button', { name: 'Links', exact: true }).click();
  await add.getByLabel('Endereços').fill(channel);
  await expect(add.getByText('1 canal ou playlist')).toBeVisible();
  await add.getByRole('button', { name: 'Incluir 1 item' }).click();
  await expect(processing(add, channel)).toBeVisible();

  await runMac(owner, topic);
  const list = processing(add, channel);
  await expect(list.getByText('Escolha o que entra')).toBeVisible();
  // Nothing enters by itself: a channel has hundreds.
  await expect(list.getByRole('checkbox', { name: /^Aula/ })).toHaveCount(3);
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await list.getByRole('checkbox', { name: /^Aula 1/ }).click();
  await list.getByRole('checkbox', { name: /^Aula 3/ }).click();
  await expect(list.getByText(/2 escolhidos · 40:00/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('channel.png') });
  await list.getByRole('button', { name: 'Incluir 2 gravações' }).click();
  await expect(list).toHaveCount(0);
  const items = add
    .getByRole('region', { name: 'Documentos em processamento' })
    .getByRole('listitem');
  await expect(items.filter({ hasText: 'Aula 1' })).toBeVisible();
  await expect(items.filter({ hasText: 'Aula 3' })).toBeVisible();
  await expect(items.filter({ hasText: 'Aula 2' })).toHaveCount(0);
  await runMac(owner, topic);
  await expect(items.filter({ hasText: 'Transcrevendo' })).toHaveCount(2);

  const sound = await readFile(makeMp3(`aula-${tag}`, 1));
  await add.getByRole('button', { name: 'Arquivos', exact: true }).click();
  await add.locator(FILES).setInputFiles({
    name: `Palestra ${tag}.mp4`,
    mimeType: 'video/mp4',
    buffer: sound,
  });
  await expect(add.getByText('1 vídeo', { exact: true })).toBeVisible();
  await add.getByRole('button', { name: 'Incluir 1 item' }).click();
  await expect(
    sentNow(add, `Palestra ${tag}.mp4`).getByText('Recebido'),
  ).toBeVisible();
});

test('the sends go on while the person uses the app, and are found on coming back', async ({
  browser,
  viewport,
}) => {
  const { page } = await person(browser, viewport);
  const add = await openAdd(page);
  const tag = uniqueTag();
  // The API takes a while to answer: the person leaves meanwhile.
  await page.route('**/api/v1/topics/*/documents', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await add.getByRole('button', { name: 'Links', exact: true }).click();
  const links = [1, 2, 3].map((n) => `https://example.org/${tag}/${n}`);
  await add.getByLabel('Endereços').fill(links.join('\n'));
  await add.getByRole('button', { name: 'Incluir 3 itens' }).click();
  await page.goBack();
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  await openAdd(page);
  await expect(add.getByText(/3 de 3 enviados/)).toBeVisible();
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
    for (const way of [
      'Arquivos',
      'Links',
      'Pesquisar na web',
      'Áudio e vídeo',
    ]) {
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

/** Links sent from the page: each is an item of one inclusion. */
async function includeLinks(
  add: Locator,
  links: readonly string[],
  total = links.length,
) {
  await add.getByRole('button', { name: 'Links', exact: true }).click();
  await add.getByLabel('Endereços').fill(links.join('\n'));
  await add.getByRole('button', { name: /^Incluir \d+ ite/ }).click();
  await expect(
    add.getByText(new RegExp(`${total} de ${total} enviados`)),
  ).toBeVisible();
}

/** The Mac as the API tells it, whatever the other tests paired. */
async function withMac(page: Page, mac: object) {
  await page.route('**/api/v1/document-uploads', async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { work: object };
    await route.fulfill({
      response: answer,
      json: { ...body, work: { ...body.work, busy: false, mac } },
    });
  });
}

test('KBC-184: what the Mac does now, the line, the time and what was spent; then the ready ones are cleared', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page, topic, owner } = await person(browser, viewport);
  const tag = uniqueTag();
  const links = [1, 2, 3].map((n) => `https://example.org/${tag}/${n}`);
  const add = await openAdd(page);
  // Room for the others while the Mac holds one: each takes up to what the month lends.
  await add.getByLabel('Teto desta inclusão (US$)').fill('5');
  await includeLinks(add, links);
  const held = await owner.post('/api/e2e/doc-ingest/run', {
    headers: CSRF,
    data: { topic, hold: true },
  });
  expect(held.status()).toBe(200);

  const card = add.locator('app-document-work-card');
  await expect(card.getByText('0 de 3 prontos')).toBeVisible();
  await expect(card.getByText('1 em andamento · 2 na fila')).toBeVisible();
  await expect(card.getByText('Mac conectado')).toBeVisible();
  await expect(card.getByText(/\/1 — Classificando, há/)).toBeVisible();
  await expect(card.getByText(/min no Mac/)).toBeVisible();
  await expect(card.getByText(/US\$ 0,00 de US\$ 5,00/)).toBeVisible();
  const working = processing(add, links[0] ?? '');
  await expect(working.getByText(/^Há menos de 1 min/)).toBeVisible();
  await expect(working.getByText('Etapa 3 de 5')).toBeAttached();
  await expect(processing(add, links[1] ?? '')).toContainText(
    /na fila|Próximo da fila/,
  );
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('progress.png') });

  await runMac(owner, topic);
  await expect(card.getByText('2 de 3 prontos')).toBeVisible();
  await add.getByRole('button', { name: 'Limpar prontos (2)' }).click();
  await expect(card.getByText('0 de 1 pronto', { exact: true })).toBeVisible();
  await expect(processing(add, links[1] ?? '')).toHaveCount(0);
});

test('KBC-184: many items have filters, the queue counts them, and the Mac that is not there is said', async ({
  browser,
  viewport,
}, testInfo) => {
  const { page } = await person(browser, viewport);
  const tag = uniqueTag();
  const add = await openAdd(page);
  await includeLinks(
    add,
    Array.from({ length: 14 }, (_, n) => `https://example.org/${tag}/${n}`),
  );
  const filters = add.getByRole('group', { name: 'Mostrar' });
  await expect(filters.getByRole('button', { name: /^Todos/ })).toHaveText(
    'Todos (14)',
  );
  await filters.getByRole('button', { name: 'Na fila (14)' }).click();
  await expect(
    add
      .getByRole('region', { name: 'Documentos em processamento' })
      .getByRole('listitem'),
  ).toHaveCount(14);

  await withMac(page, { state: 'none', lastSeenAt: null });
  await page.goto('/fila');
  const queue = page.locator('app-processing-queue-page');
  // The phone's head has no room for the count: the card has it.
  if (desktop(page)) await expect(queue.getByText(/^14 itens/)).toBeVisible();
  await expect(queue.getByText('0 de 14 prontos')).toBeVisible();
  await expect(queue.getByText('Nenhum Mac conectado')).toBeVisible();
  await expect(queue.getByText(/Peça a um master/)).toBeVisible();
  await expect(queue.getByText(/liga sozinho/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('queue-no-mac.png') });
  const wide = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(wide).toBeLessThanOrEqual(0);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`KBC-184: the progress passes axe in the ${theme} theme, at every state`, async ({
    browser,
    viewport,
  }, testInfo) => {
    const { page, topic, owner } = await person(browser, viewport);
    await page.addInitScript(
      (value) => localStorage.setItem('kb-chat.theme', value),
      theme,
    );
    await withMac(page, {
      state: 'off',
      lastSeenAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    await page.reload();
    const tag = uniqueTag();
    const add = await openAdd(page);
    await includeLinks(add, [
      `https://example.org/${tag}`,
      `https://quebrado.example/${tag}`,
      `https://www.youtube.com/@canal${tag.replace(/[^a-z0-9]/gi, '')}`,
    ]);
    await runMac(owner, topic);
    await includeLinks(add, [`https://example.org/${tag}/espera`], 4);
    const section = add.getByRole('region', {
      name: 'Documentos em processamento',
    });
    await expect(section.getByText('Mac desligado')).toBeVisible();
    await expect(section.getByText(/Visto há 2 h/)).toBeVisible();
    await expect(section.getByText('Falhou', { exact: true })).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`progress-${theme}.png`),
    });
    const serious = (
      await new AxeBuilder({ page })
        .include('app-document-uploads-section')
        .analyze()
    ).violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious).toEqual([]);
  });
}

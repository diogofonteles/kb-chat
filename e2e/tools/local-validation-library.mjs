// KBC-051 local validation: the media library (T16) in each state, at 1440 and 390 px,
// on the E2E servers (Google Chrome: it plays AAC).
// Usage: node e2e/tools/local-validation-library.mjs http://localhost:4351 <dir>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const dir = mkdtempSync(join(tmpdir(), 'kbchat-lv-library-'));
const tag = Date.now().toString(36);

const tone = (name, seconds) => {
  const path = join(dir, `${name}.mp3`);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=330:duration=${seconds}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '96k',
    path,
  ]);
  return readFileSync(path);
};

const browser = await chromium.launch({ channel: 'chrome' });

async function signIn(request, email) {
  const token = await request.post('/api/e2e/token', {
    data: { email },
    headers: CSRF,
  });
  const { credential } = await token.json();
  await request.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
}

const admin = await browser.newContext({ baseURL: base });
await signIn(admin.request, 'owner@kb-chat.test');

async function upload(title, seconds, authorship = 'outros-autores') {
  const body = tone(title.replace(/\W+/g, '-').slice(0, 40), seconds);
  const created = await admin.request.post('/api/v1/topics/hermetismo/media', {
    data: { title, authorship, fileName: 'a.mp3', bytes: body.length },
    headers: CSRF,
  });
  const { id } = await created.json();
  await admin.request.put(`/api/v1/media/${id}/file`, {
    data: body,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  });
  for (let i = 0; i < 120; i++) {
    const item = await (await admin.request.get(`/api/v1/media/${id}`)).json();
    if (item.status === 'ready') return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${title} never became ready`);
}

const ids = [
  await upload(`Palestra sobre o Caiano ${tag}`, 90, 'mestre-laercio'),
  await upload(`Aula de Hermetismo ${tag}`, 60),
  await upload(`Ensino da Burracheira ${tag}`, 45, 'mestre-laercio'),
  await upload(`Sessão de estudo ${tag}`, 30),
  await upload(
    `Uma palestra com um título muito longo, de duzentos caracteres, para ver como a linha quebra em duas linhas com reticências e o título inteiro continua no nome acessível ${tag}`.slice(
      0,
      200,
    ),
    20,
  ),
];

/** A person with the library on hermetismo, one per width (their own positions). */
async function person(label, features = ['search', 'media', 'media-library']) {
  const email = `lv-${label}-${tag}@kb-chat.test`;
  const invited = await admin.request.post('/api/v1/people', {
    data: { email },
    headers: CSRF,
  });
  const { id } = await invited.json();
  await admin.request.patch(`/api/v1/people/${id}`, {
    data: { topics: ['hermetismo'], features },
    headers: CSRF,
  });
  return email;
}

async function pageFor(email, viewport, theme = 'light') {
  const context = await browser.newContext({ baseURL: base, viewport });
  await context.addInitScript((value) => {
    localStorage.setItem('kb-chat.theme', value);
  }, theme);
  const page = await context.newPage();
  await signIn(page.request, email);
  return page;
}

const shot = (page, name) =>
  page.screenshot({ path: join(out, `${name}.png`), fullPage: false });

/** Types in "Buscar na biblioteca" and waits for that answer (a new answer clears a selection). */
async function search(page, words) {
  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get('q') === words.trim(),
  );
  await page.getByLabel('Buscar na biblioteca').fill(words);
  await answered;
}

async function openLibrary(page) {
  await page.goto('/biblioteca');
  await page.getByRole('heading', { name: 'Biblioteca', level: 2 }).waitFor();
}

const widths = [
  ['1440', { width: 1440, height: 900 }],
  ['390', { width: 390, height: 844 }],
];

for (const [width, viewport] of widths) {
  const email = await person(`w${width}`);
  const page = await pageFor(email, viewport);
  for (const [n, ms] of [
    [0, 40_000],
    [1, 20_000],
    [2, 10_000],
  ])
    await page.request.put(`/api/v1/media/${ids[n]}/progress`, {
      data: { positionMs: ms, basedOn: null },
      headers: CSRF,
    });

  // Loading: the answers held back.
  await page.route('**/api/v1/media/library**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.continue();
  });
  await page.goto('/biblioteca');
  await page.getByRole('list', { name: 'Carregando…' }).waitFor();
  await shot(page, `${width}-01-loading`);
  await page.unroute('**/api/v1/media/library**');

  await openLibrary(page);
  await search(page, tag);
  await page.getByText(/^5 mídias/).waitFor();
  await page.evaluate(() =>
    document.querySelector('app-library-page')?.scrollTo(0, 0),
  );
  await shot(page, `${width}-02-home-list`);
  await page.getByRole('region', { name: 'Todas' }).scrollIntoViewIfNeeded();
  await shot(page, `${width}-03-all-list-long-title`);

  await page
    .getByRole('checkbox', { name: /Selecionar Aula de Hermetismo/ })
    .check();
  await page
    .getByRole('checkbox', { name: /Selecionar Sessão de estudo/ })
    .check();
  await shot(page, `${width}-04-selection`);
  await page.getByRole('button', { name: 'Cancelar seleção' }).click();

  await page
    .getByRole('button', { name: 'Ordenar: Ouvidas recentemente' })
    .click();
  await shot(page, `${width}-05-sort-menu`);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Ver em grade' }).click();
  await page.getByRole('region', { name: 'Todas' }).scrollIntoViewIfNeeded();
  await shot(page, `${width}-06-grid`);
  await page.getByRole('button', { name: 'Ver em lista' }).click();

  const inProgress = page.getByRole('button', { name: 'Em andamento' });
  await inProgress.click();
  await page
    .locator('button[aria-pressed="true"]', { hasText: 'Em andamento' })
    .waitFor();
  await page.getByLabel('Autoria').selectOption('outros-autores');
  await search(page, `${tag} burracheira`);
  await page.getByText('Nenhuma mídia').waitFor();
  await shot(page, `${width}-07-search-no-result`);
  await search(page, tag);
  await page.getByText(/^1 mídia/).waitFor();
  await page.getByRole('button', { name: 'Limpar filtros' }).first().click();

  const recents = page.getByRole('region', { name: 'Ouvidas recentemente' });
  await recents.getByRole('button', { name: 'Limpar recentes' }).click();
  await recents.scrollIntoViewIfNeeded();
  await shot(page, `${width}-08-clear-recents-confirm`);
  await recents.getByRole('button', { name: 'Limpar', exact: true }).click();
  await recents.getByText('Nada ouvido desde que você limpou.').waitFor();
  await shot(page, `${width}-09-recents-cleared`);

  await page
    .getByRole('region', { name: 'Continuar ouvindo' })
    .getByRole('button', { name: /^Tocar Palestra sobre o Caiano/ })
    .click();
  await page.getByRole('region', { name: 'Mini-player' }).waitFor();
  await shot(page, `${width}-10-playing-mini-player`);
  await page
    .getByRole('button', { name: /^Pausar Palestra sobre o Caiano/ })
    .first()
    .click();

  // Error: the list fails, what was there stays.
  await page.route('**/api/v1/media/library?**', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'INTERNAL' } } }),
  );
  await page.getByRole('button', { name: 'Em andamento' }).click();
  await page.getByText('Não consegui carregar a Biblioteca.').waitFor();
  await page.evaluate(() =>
    document.querySelector('app-library-page')?.scrollTo(0, 0),
  );
  await shot(page, `${width}-11-error`);
  await page.unroute('**/api/v1/media/library?**');
  await page.getByRole('button', { name: 'Em andamento' }).click();
  await page.context().close();

  // Empty: a person on a collection with no media, who only listens.
  const empty = await pageFor(
    await (async () => {
      const mail = `lv-vazio-${width}-${tag}@kb-chat.test`;
      const invited = await admin.request.post('/api/v1/people', {
        data: { email: mail },
        headers: CSRF,
      });
      const { id } = await invited.json();
      await admin.request.patch(`/api/v1/people/${id}`, {
        data: {
          topics: ['alquimia'],
          features: ['search', 'media', 'media-library'],
        },
        headers: CSRF,
      });
      return mail;
    })(),
    viewport,
  );
  await openLibrary(empty);
  await empty
    .getByText('Ainda não há mídias nos acervos liberados para você.')
    .waitFor();
  await shot(empty, `${width}-12-empty-reader`);
  await empty.context().close();

  for (const theme of ['dark', 'esoteric']) {
    const themed = await pageFor(email, viewport, theme);
    await openLibrary(themed);
    await search(themed, tag);
    await themed.getByText(/^5 mídias/).waitFor();
    await shot(themed, `${width}-13-${theme}`);
    await themed.context().close();
  }
}

await browser.close();
console.log(`screenshots in ${out}`);

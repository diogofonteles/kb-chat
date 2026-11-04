// KBC-050 local validation: "Editar informações" in each state, at 1440 and 390 px, on the
// E2E servers (Google Chrome: it plays AAC).
// Usage: node e2e/tools/local-validation-edit.mjs http://localhost:4350 <dir>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const dir = mkdtempSync(join(tmpdir(), 'kbchat-lv-edit-'));
const tag = Date.now().toString(36);

const tone = (name) => {
  const path = join(dir, `${name}.mp3`);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=2',
    '-c:a',
    'libmp3lame',
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

async function person(label, viewport, features) {
  const email = `${label}-${tag}@example.com`;
  const invited = await admin.request.post('/api/v1/people', {
    data: { email, sendEmail: false },
    headers: CSRF,
  });
  const { id } = await invited.json();
  await admin.request.patch(`/api/v1/people/${id}`, {
    data: { topics: ['hermetismo', 'alquimia'], features },
    headers: CSRF,
  });
  const context = await browser.newContext({ baseURL: base, viewport });
  await signIn(context.request, email);
  return context.newPage();
}

async function upload(page, title) {
  const body = tone(title.replace(/\W+/g, '-'));
  const created = await page.request.post('/api/v1/topics/hermetismo/media', {
    data: { title, author: null, fileName: 'a.mp3', bytes: body.length },
    headers: CSRF,
  });
  const { id } = await created.json();
  await page.request.put(`/api/v1/media/${id}/file`, {
    data: body,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  });
  for (let tries = 0; tries < 120; tries++) {
    const read = await page.request.get(`/api/v1/media/${id}`);
    if ((await read.json()).status === 'ready') return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('never ready');
}

const shot = (page, width, name) =>
  page.screenshot({ path: join(out, `${width}-${name}.png`) });

async function openMedia(page, width) {
  await page.goto('/');
  if (width < 1024) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await page.getByRole('heading', { name: /Mídia — Hermetismo/ }).waitFor();
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  const page = await person(`edit${width}`, { width, height }, [
    'search',
    'media',
    'media-upload',
  ]);
  const title = `Palestra de 1998 sobre a lei do ritmo ${width} ${tag}`;
  const other = `Aula que fica ${width} ${tag}`;
  const id = await upload(page, title);
  await upload(page, other);
  await openMedia(page, width);
  await shot(page, width, '1-list');
  await page.getByRole('button', { name: `Mais ações para ${title}` }).click();
  await shot(page, width, '2-menu');
  await page.getByRole('menuitem', { name: 'Editar informações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar informações' });
  await dialog.waitFor();
  await shot(page, width, '3-dialog');
  await dialog.getByLabel('Título').fill('   ');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await shot(page, width, '4-empty-title');
  await dialog.getByLabel('Título').fill(title);
  await dialog.getByLabel('Acervo', { exact: true }).selectOption('alquimia');
  await dialog.getByRole('combobox', { name: /Autor/ }).fill('Ana Lima');
  await shot(page, width, '5-moving');
  await page.route('**/api/v1/media/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, json: {} })
      : route.fallback(),
  );
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await dialog.getByRole('alert').waitFor();
  await shot(page, width, '6-server-error');
  await page.unrouteAll();
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await page.getByRole('link', { name: 'Ver o acervo' }).waitFor();
  await shot(page, width, '7-moved');
  await page.getByRole('link', { name: 'Ver o acervo' }).click();
  await page.getByRole('heading', { name: /Mídia — Alquimia/ }).waitFor();
  await page.getByRole('link', { name: title }).waitFor();
  await shot(page, width, '8-new-collection');
  await page.goto(`/midia/${id}`);
  await page.getByRole('button', { name: 'Editar informações' }).waitFor();
  await shot(page, width, '9-player-page');
}
await browser.close();

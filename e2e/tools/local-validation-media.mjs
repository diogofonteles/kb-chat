// KBC-034 and KBC-041 local validation: the media list (T14), the upload panel, the player
// (T15) in every state, its menus and shortcuts, "Continuar de" and the mini-player, at
// 1440 and 390 px, in the three themes, on the E2E servers (Google Chrome: it plays AAC). Usage: node e2e/tools/local-validation-media.mjs http://localhost:4327 <dir>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const dir = mkdtempSync(join(tmpdir(), 'kbchat-lv-media-'));
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

const browser = await chromium.launch({
  args: ['--mute-audio'],
  channel: 'chrome',
});
const admin = await browser.newContext({ baseURL: base });
async function signIn(request) {
  const token = await request.post('/api/e2e/token', {
    data: { email: 'owner@kb-chat.test' },
    headers: CSRF,
  });
  const { credential } = await token.json();
  await request.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
}
await signIn(admin.request);

async function create(title, body, send = true) {
  const created = await admin.request.post('/api/v1/topics/hermetismo/media', {
    data: {
      title,
      author: 'mestre-laercio',
      fileName: 'a.mp3',
      bytes: body.length,
    },
    headers: CSRF,
  });
  const { id } = await created.json();
  if (send)
    await admin.request.put(`/api/v1/media/${id}/file`, {
      data: body,
      headers: { ...CSRF, 'content-type': 'application/octet-stream' },
    });
  return id;
}
const lecture = await create(
  'Os sete princípios herméticos — palestra de 1998 em Brasília, com perguntas do público ao final',
  tone('lecture', 180),
);
await create(
  'Arquivo corrompido enviado por engano',
  Buffer.from('not audio at all '.repeat(200)),
);
await create('Envio interrompido', tone('partial', 2), false);
await new Promise((resolve) => setTimeout(resolve, 4000));

const report = [];
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark', 'esoteric']) {
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width, height: 900 },
    });
    await context.route('https://accounts.google.com/**', (r) =>
      r.fulfill({ body: '', contentType: 'text/javascript' }),
    );
    await context.addInitScript((value) => {
      localStorage.setItem('kb-chat.theme', value);
      localStorage.setItem('kb-chat.view', 'search');
    }, theme);
    await signIn(context.request);
    const page = await context.newPage();
    const shot = async (name) => {
      await page.screenshot({
        path: join(out, `${width}-${theme}-${name}.png`),
        fullPage: false,
      });
      report.push(
        `${width} ${theme} ${name}: overflow ${await overflow(page)}px`,
      );
    };
    await page.goto('/midia');
    await page.getByText('Pronta').first().waitFor();
    await shot('01-list');
    await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'apostila.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    });
    await dialog.getByRole('button', { name: 'Enviar' }).click();
    await shot('02-upload-errors');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await page
      .getByRole('button', { name: /^Mais ações para Arquivo corrompido/ })
      .first()
      .click();
    await shot('03a-row-menu');
    await page.getByRole('menuitem', { name: 'Remover' }).click();
    await shot('03-remove-confirm');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancelar' })
      .click();
    await page.goto(`/midia/${lecture}`);
    await page.getByRole('button', { name: 'Tocar' }).waitFor();
    await shot('04-player-ready');
    await page.getByRole('button', { name: 'Tocar' }).click();
    await page.waitForTimeout(1500);
    const position = page.getByRole('slider', { name: 'Posição' });
    await position.focus();
    await position.press('PageUp');
    await page.waitForTimeout(800);
    await shot('05-player-playing');
    await page.getByRole('button', { name: 'Pausar' }).click();
    await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
    await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
    await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
    await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
    await page.getByRole('button', { name: 'Ouvir de novo' }).waitFor();
    await shot('06-player-ended');
    await page.getByRole('button', { name: /^Velocidade/ }).click();
    await shot('08-speed-menu');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Atalhos de teclado' }).click();
    await shot('09-shortcuts-dialog');
    await page.keyboard.press('Escape');
    // "Pulos" (KBC-043): the dialog, then the buttons with the chosen numbers.
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Pulos' }).click();
    const skips = page.getByRole('dialog', { name: 'Pulos' });
    await skips
      .getByRole('group', { name: 'Voltar' })
      .getByRole('radio', { name: '10 s', exact: true })
      .check();
    await skips
      .getByRole('group', { name: 'Avançar' })
      .getByRole('radio', { name: '45 s', exact: true })
      .check();
    await shot('09b-skips-dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Voltar 10 segundos' }).waitFor();
    await shot('09c-player-skips');
    // Back to the defaults, so the next theme starts the same.
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Pulos' }).click();
    await skips
      .getByRole('group', { name: 'Voltar' })
      .getByRole('radio', { name: '15 s', exact: true })
      .check();
    await skips
      .getByRole('group', { name: 'Avançar' })
      .getByRole('radio', { name: '30 s', exact: true })
      .check();
    await page.keyboard.press('Escape');
    // A saved position: back on the page, "Continuar de".
    await position.focus();
    await position.press('Home');
    await position.press('PageUp');
    await page.getByRole('button', { name: 'Tocar' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Pausar' }).click();
    await page.waitForTimeout(600);
    await page.goto('/midia');
    await page.goto(`/midia/${lecture}`);
    await page.getByRole('button', { name: /Continuar de/ }).waitFor();
    await shot('10-resume');
    // Playing, then away to search: the mini-player.
    await page.getByRole('button', { name: /Continuar de/ }).click();
    await page.getByRole('link', { name: '← Mídia' }).click();
    const menu = page.getByRole('button', { name: 'Menu' });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: /Nova conversa/ }).click();
    await page.getByLabel('Sua pergunta').fill('ritmo');
    await page.getByLabel('Sua pergunta').press('Enter');
    await page.getByText(/documentos · Tudo ·/).waitFor();
    await shot('11-mini-player-results');
    const saved = page.waitForResponse((response) =>
      response.url().endsWith('/progress'),
    );
    await page
      .getByRole('region', { name: 'Mini-player' })
      .getByRole('button', { name: 'Fechar o player' })
      .click();
    await saved;
    // The list shows where the person stopped (T14).
    await page.goto('/midia');
    await page
      .getByText(/Continuar de/)
      .first()
      .waitFor();
    await shot('12-list-resume');
    await page.goto('/midia/00000000-0000-4000-8000-000000000999');
    await page.getByRole('alert').waitFor();
    await shot('07-not-found');
    await context.close();
  }
}
await browser.close();
console.log(report.join('\n'));

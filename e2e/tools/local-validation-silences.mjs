// KBC-044 local validation: "Encurtar silêncios" in the player's "Mais opções" (T15) —
// the menu, the dialog while the map is measured, off, on with the time saved after a
// pause was jumped, at 1440 and 390 px in the three themes, on the E2E servers (Google
// Chrome: it plays AAC). Usage: node e2e/tools/local-validation-silences.mjs <web> <dir>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const dir = mkdtempSync(join(tmpdir(), 'kbchat-lv-silences-'));

/** A 60 s tone with 3 s pauses at 4–7 s and 20–23 s and a 0.5 s one at 12 s. */
function lectureWithPauses() {
  const path = join(dir, 'pauses.mp3');
  const silent = 'between(t,4,7)+between(t,12,12.5)+between(t,20,23)';
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='if(${silent},0,0.5*sin(2*PI*330*t))':s=44100:d=60`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '96k',
    path,
  ]);
  return readFileSync(path);
}

const browser = await chromium.launch({ channel: 'chrome' });
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

const body = lectureWithPauses();
const created = await admin.request.post('/api/v1/topics/hermetismo/media', {
  data: {
    title: 'Palestra com pausas longas — perguntas do público ao final',
    author: 'mestre-laercio',
    fileName: 'pausas.mp3',
    bytes: body.length,
  },
  headers: CSRF,
});
const { id } = await created.json();
await admin.request.put(`/api/v1/media/${id}/file`, {
  data: body,
  headers: { ...CSRF, 'content-type': 'application/octet-stream' },
});
for (let tries = 0; tries < 60; tries++) {
  const map = await (
    await admin.request.get(`/api/v1/media/${id}/silences`)
  )
    .json()
    .catch(() => ({}));
  if (map.status === 'ready') break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const report = [];
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const setSkipSilences = (request, on) =>
  request.put('/api/v1/media/preferences', {
    data: {
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: on,
    },
    headers: CSRF,
  });

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
    }, theme);
    await signIn(context.request);
    await setSkipSilences(context.request, false);
    const page = await context.newPage();
    const shot = async (name) => {
      await page.screenshot({
        path: join(out, `${width}-${theme}-${name}.png`),
      });
      report.push(
        `${width} ${theme} ${name}: overflow ${await overflow(page)}px`,
      );
    };
    const openDialog = async () => {
      await page.getByRole('button', { name: 'Mais opções' }).click();
      await page.getByRole('menuitem', { name: /^Encurtar silêncios/ }).click();
      return page.getByRole('dialog', { name: 'Encurtar silêncios' });
    };
    await page.goto(`/midia/${id}`);
    await page.getByRole('button', { name: 'Mais opções' }).waitFor();
    await page.waitForTimeout(1500);
    const fromStart = page.getByRole('button', { name: 'Começar do início' });
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await shot('01-more-menu');
    await page.keyboard.press('Escape');
    let dialog = await openDialog();
    await shot('02-dialog-off');
    await dialog.getByRole('checkbox', { name: 'Encurtar silêncios' }).check();
    await page.keyboard.press('Escape');
    // A position saved by the previous theme offers "Começar do início", which plays.
    if (await fromStart.isVisible()) await fromStart.click();
    else await page.getByRole('button', { name: 'Tocar' }).click();
    // The 3 s pause at 4 s is jumped; play on past it.
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-media-engine]')?.currentTime ?? 0) > 8,
      null,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: 'Pausar' }).click();
    await shot('03-player-after-skip');
    dialog = await openDialog();
    await dialog.getByText(/Tempo economizado/).waitFor();
    await shot('04-dialog-on-saved');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await shot('05-more-menu-on');
    await page.keyboard.press('Escape');
    // A media whose map is still being measured (the worker has not reached it yet).
    await page.route('**/api/v1/media/*/silences', (route) =>
      route.fulfill({
        json: {
          status: 'pending',
          version: null,
          minSilenceMs: 1000,
          intervals: [],
        },
      }),
    );
    await page.reload();
    await page
      .getByRole('button', { name: /^(Tocar|Continuar de .*)$/ })
      .first()
      .waitFor();
    dialog = await openDialog();
    await dialog.getByText('ainda estão sendo medidos').waitFor();
    await shot('06-dialog-pending');
    await context.close();
  }
}
await browser.close();
writeFileSync(join(out, 'report.txt'), `${report.join('\n')}\n`);
console.log(report.join('\n'));

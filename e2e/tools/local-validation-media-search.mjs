// KBC-039 local validation: spoken passages mixed with the documents, "Buscar em" and the
// passage playing in the reading panel, at 1440 and 390 px, light and dark, on the E2E
// servers (an audio of 8:20 seeded with a transcript; one in low confidence).
// Usage: node e2e/tools/local-validation-media-search.mjs http://localhost:4363 <dir> <ffmpeg>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out, ffmpeg = 'ffmpeg'] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const browser = await chromium.launch({ channel: 'chrome' });

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

const raw = (passages, low) => ({
  chunks: [
    {
      offset: 0,
      end: 500,
      result: {
        segments: passages.map(([at, text]) => ({
          start: at,
          end: at + 4,
          text: ` ${text}`,
          avg_logprob: low ? -1.2 : -0.2,
          compression_ratio: 1.3,
          no_speech_prob: 0.01,
          words: text.split(' ').map((word, i) => ({
            word: ` ${word}`,
            start: at + i * 0.3,
            end: at + (i + 1) * 0.3,
            probability: low ? 0.3 : 0.95,
          })),
        })),
      },
    },
  ],
});

const dir = mkdtempSync(join(tmpdir(), 'kbchat-lv-'));
const mp3 = join(dir, 'aula.mp3');
execFileSync(ffmpeg, [
  ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi'],
  ...['-i', 'sine=frequency=330:duration=500', '-c:a', 'libmp3lame', mp3],
]);

const admin = await browser.newContext({ baseURL: base });
await signIn(admin.request);
const api = admin.request;

async function talk(title, passages, low = false) {
  const body = readFileSync(mp3);
  const created = await api.post('/api/v1/topics/hermetismo/media', {
    data: {
      title,
      author: 'mestre-laercio',
      fileName: 'aula.mp3',
      bytes: body.length,
    },
    headers: CSRF,
  });
  const { id } = await created.json();
  await api.put(`/api/v1/media/${id}/file`, {
    data: body,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  });
  for (let i = 0; i < 120; i++) {
    const seeded = await api.post(`/api/e2e/media/${id}/transcript`, {
      data: { raw: raw(passages, low) },
      headers: CSRF,
    });
    if (seeded.status() === 204) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no transcript for ${title}`);
}

const tag = Date.now().toString(36);
await talk(`Palestra sobre a setuplicidade e o Tiuaco (${tag})`, [
  [12, `Bom dia a todos, hoje falamos da setuplicidade ${tag}.`],
  [495, `Tiuaco é Mariri, e a setuplicidade da natureza mostra isso ${tag}.`],
]);
await talk(
  `Gravação ruidosa de uma sessão antiga sobre a setuplicidade (${tag})`,
  [[300, `a setuplicidade setuplicidade da vida que se repete ${tag}`]],
  true,
);

const report = [];
for (const theme of ['light', 'dark']) {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width, height: width > 1000 ? 900 : 844 },
    });
    await context.addInitScript((value) => {
      localStorage.setItem('kb-chat.theme', value);
      localStorage.removeItem('kb-chat.search-kinds');
    }, theme);
    await signIn(context.request);
    const page = await context.newPage();
    await page.goto('/');
    const box = page.getByRole('textbox', { name: 'Sua pergunta' });
    await box.fill(`setuplicidade ${tag}`);
    await box.press('Enter');
    await page.locator('[data-media-id]').first().waitFor();
    const name = `${width}-${theme}`;
    await page.screenshot({
      path: `${out}/results-${name}.png`,
      fullPage: false,
    });
    await page.locator('[data-media-id]').first().click();
    await page.getByRole('slider', { name: 'Posição' }).waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/panel-${name}.png` });
    const time = await page
      .locator('[data-media-engine]')
      .evaluate((audio) => audio.currentTime);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (theme === 'light') {
      await page
        .getByRole('button', { name: /Fechar/ })
        .first()
        .click();
      await page
        .getByRole('group', { name: 'Buscar em' })
        .getByRole('checkbox', { name: /Textos/ })
        .uncheck();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/audio-only-${name}.png` });
    }
    report.push({ name, currentTime: time, overflow });
    await context.close();
  }
}
console.log(JSON.stringify(report, null, 2));
await browser.close();

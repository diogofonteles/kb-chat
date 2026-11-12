// KBC-106 local validation: a track above its recording's level. Ana (CI) on the player
// (T15: the hatched "Trecho restrito", the transcript), the editor's "Nível" on the track row
// (T20 step 3), "Editar faixa" and the confirmation of "Editar informações" raising the
// recording, at 1440 and 390 px, on the E2E servers (Google Chrome: it plays AAC).
// Usage: node e2e/tools/local-validation-track-levels.mjs http://localhost:4618 <dir>
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const tag = Date.now().toString(36);
const dir = mkdtempSync(join(tmpdir(), 'kbchat-lv-levels-'));
const tone = (seconds) => {
  const path = join(dir, 'tone.mp3');
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

async function signedIn(email, viewport) {
  const context = await browser.newContext({ baseURL: base, viewport });
  const token = await context.request.post('/api/e2e/token', {
    data: { email },
    headers: CSRF,
  });
  const { credential } = await token.json();
  await context.request.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  return context;
}

const ok = async (response, what) => {
  if (!response.ok())
    throw new Error(`${what}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
};

const admin = await signedIn('owner@kb-chat.test', {
  width: 1440,
  height: 900,
});
const api = admin.request;
const { slug: topic } = await ok(
  await api.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: `Palestras ${tag}` },
  }),
  'topic',
);
for (const code of ['QS', 'CI', 'CDC', 'QM'])
  await ok(
    await api.post(`/api/v1/topics/${topic}/levels`, {
      data: { code },
      headers: CSRF,
    }),
    'level',
  );
const body = tone(60);
const media = await ok(
  await api.post(`/api/v1/topics/${topic}/media`, {
    data: {
      title: 'Palestra aberta',
      author: null,
      fileName: 'a.mp3',
      bytes: body.length,
      level: 'ci',
    },
    headers: CSRF,
  }),
  'media',
);
await ok(
  await api.put(`/api/v1/media/${media.id}/file`, {
    data: body,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  }),
  'file',
);
for (let i = 0; i < 120; i++) {
  const item = await ok(await api.get(`/api/v1/media/${media.id}`), 'item');
  if (item.status === 'ready') break;
  await new Promise((done) => setTimeout(done, 500));
}
const lines = [
  [0, 14, 'Mestre, o senhor está lembrado daquele dia?'],
  [15.5, 22, 'E como foi que o senhor chegou lá?'],
  [22.5, 39, 'Cheguei pela mão de um amigo que trabalhava na construção.'],
  [40.5, 59, 'Respondo com alegria: o vegetal é a nossa comunhão.'],
];
await ok(
  await api.post(`/api/e2e/media/${media.id}/transcript`, {
    data: {
      raw: {
        chunks: [
          {
            offset: 0,
            end: 60,
            result: {
              segments: lines.map(([start, end, text]) => ({
                start,
                end,
                text: ` ${text}`,
                avg_logprob: -0.2,
                compression_ratio: 1.3,
                no_speech_prob: 0.01,
                words: text.split(' ').map((word, index, all) => ({
                  word: ` ${word}`,
                  start: start + ((end - start) * index) / all.length,
                  end: start + ((end - start) * (index + 1)) / all.length,
                  probability: 0.95,
                })),
              })),
            },
          },
        ],
      },
    },
    headers: CSRF,
  }),
  'transcript',
);
const tracks = [
  [0, 15_000, 'Primeira pergunta', null],
  [15_000, 40_000, 'Pergunta sensível', 'cdc'],
  [40_000, 59_000, 'Terceira pergunta', null],
];
await ok(
  await api.put(`/api/v1/media/${media.id}/edit`, {
    data: {
      step: 3,
      tracks: tracks.map(([startMs, endMs, title, level]) => ({
        id: randomUUID(),
        source: 'manual',
        kind: 'qa',
        startMs,
        endMs,
        title,
        level,
        askerVoice: null,
        answererVoice: null,
        askerSpeakerId: null,
        answererSpeakerId: null,
      })),
    },
    headers: { ...CSRF, 'if-match': '"0"' },
  }),
  'draft',
);
await ok(
  await api.post(`/api/v1/media/${media.id}/edit/approve`, {
    data: {},
    headers: { ...CSRF, 'if-match': '"1"' },
  }),
  'approve',
);
for (let i = 0; i < 120; i++) {
  const edit = await ok(
    await api.get(`/api/v1/media/${media.id}/edit`),
    'edit',
  );
  if (edit.preparation === null) break;
  await new Promise((done) => setTimeout(done, 500));
}
const ana = `ana-${tag}@kb-chat.test`;
const { id: anaId } = await ok(
  await api.post('/api/v1/people', { data: { email: ana }, headers: CSRF }),
  'invite',
);
await ok(
  await api.patch(`/api/v1/people/${anaId}`, {
    data: {
      topics: [topic],
      features: ['search', 'media', 'media-tracks'],
      levels: { [topic]: 'ci' },
    },
    headers: CSRF,
  }),
  'ana',
);
// A second recording for the editor's row: its draft not approved.
const other = await ok(
  await api.post(`/api/v1/topics/${topic}/media`, {
    data: {
      title: 'Palestra em edição',
      author: null,
      fileName: 'b.mp3',
      bytes: body.length,
      level: 'ci',
    },
    headers: CSRF,
  }),
  'other',
);
await ok(
  await api.put(`/api/v1/media/${other.id}/file`, {
    data: body,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  }),
  'other file',
);
for (let i = 0; i < 120; i++) {
  const item = await ok(await api.get(`/api/v1/media/${other.id}`), 'other');
  if (item.status === 'ready') break;
  await new Promise((done) => setTimeout(done, 500));
}
await ok(
  await api.put(`/api/v1/media/${other.id}/edit`, {
    data: {
      step: 3,
      tracks: tracks.map(([startMs, endMs, title]) => ({
        id: randomUUID(),
        source: 'manual',
        kind: 'qa',
        startMs,
        endMs,
        title,
        askerVoice: null,
        answererVoice: null,
        askerSpeakerId: null,
        answererSpeakerId: null,
      })),
    },
    headers: { ...CSRF, 'if-match': '"0"' },
  }),
  'other draft',
);
const library = await ok(await api.get('/api/v1/media/library'), 'library');
const sensitive = library.items
  .find((one) => one.id === media.id)
  ?.tracks.find((one) => one.title === 'Pergunta sensível');

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const w = viewport.width;
  const listener = await signedIn(ana, viewport);
  const page = await listener.newPage();
  await page.goto(`/midia/${media.id}?t=12`);
  await page.getByTestId('restricted').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/ana-player-${w}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await page.waitForTimeout(4500);
  const at = await page
    .locator('[data-media-engine]')
    .evaluate((element) => element.currentTime);
  console.log(`ana ${w}: playing at ${at.toFixed(2)} s after 4.5 s from 12 s`);
  await page.screenshot({ path: `${out}/ana-skipped-${w}.png` });
  await listener.close();

  const editor = await signedIn('owner@kb-chat.test', viewport);
  const owned = await editor.newPage();
  await owned.goto(`/midia/${other.id}/faixas`);
  const row = owned
    .getByRole('list', { name: 'Faixas' })
    .getByRole('listitem')
    .nth(1);
  await row.getByRole('button').first().click();
  await row.getByRole('combobox', { name: 'Nível' }).selectOption('cdc');
  await row.getByText('Nível: CDC').waitFor();
  await row.getByRole('combobox', { name: 'Nível' }).scrollIntoViewIfNeeded();
  await owned.screenshot({ path: `${out}/editor-row-${w}.png` });

  if (sensitive) {
    await owned.goto(`/midia/${sensitive.id}`);
    await owned.getByRole('button', { name: 'Editar', exact: true }).click();
    await owned.locator('#track-level').waitFor();
    await owned.screenshot({ path: `${out}/track-edit-${w}.png` });
  }

  await owned.goto(`/midia/${media.id}`);
  await owned.getByRole('heading', { name: 'Palestra aberta' }).waitFor();
  await owned.waitForTimeout(800);
  await owned.screenshot({
    path: `${out}/master-player-${w}.png`,
    fullPage: true,
  });
  await owned.getByRole('button', { name: 'Editar informações' }).click();
  const dialog = owned.getByRole('dialog', { name: 'Editar informações' });
  await dialog.getByRole('radio', { name: 'QM' }).check();
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await dialog.getByText('1 faixa com nível próprio sobe para QM.').waitFor();
  await owned.screenshot({ path: `${out}/raise-confirm-${w}.png` });
  await dialog.getByRole('button', { name: 'Cancelar' }).first().click();
  await editor.close();
}
await browser.close();
console.log('done', media.id, other.id);

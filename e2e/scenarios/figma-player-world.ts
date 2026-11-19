import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import {
  CSRF,
  WEB_ORIGIN,
  expect,
  fakeGoogle,
  invite,
  ownerApi,
  signIn,
} from '../specs/fixtures.js';
import { TURNS, separateVoices } from '../specs/voices-helpers.js';
import {
  MINUTE,
  OWNER,
  TOPIC,
  TRANSCRIBER_OFF_SINCE,
  figmaWorld,
  recentCollections,
  withUploadDate,
  seedWorld,
  type Line,
  type World,
} from './figma-library-world.js';

/**
 * The sample data of the v2 · Mídia — Player, Fila e Marcadores and Preparar, Faixas e
 * Limites frames (figma-recreation's redesign/src/features/player.js, queue.js, prepare.js):
 * the library's world (figma-library-world.ts: the same eleven media of "Alquimia Prática",
 * the interview playing at 0:22 in every frame), plus what these frames show of it.
 *
 * Seeded for real, through the API:
 * - the transcripts the player draws: the interview's minute (0:00 … 0:45), the Caibalion's
 *   reading, the noisy recording's two uncertain lines and the seven principles;
 * - the voices of the interview, of the recording and of "Roda de perguntas para validar"
 *   (Voz 1 0:12, Voz 2 0:41, Voz 3 0:05), named on the first two: Mestre Álvaro Nunes,
 *   Sérgio Andrade and the audience ("Pergunta da plateia");
 * - the interview's three bookmarks (0:05 "O dia da sessão", 0:22 "Quem o levou: um amigo da
 *   construção", 0:45 with no note), the library's other eight kept and one more: "Lista ·
 *   12 marcadores";
 * - the draft of "Roda de perguntas para validar": Primeira pergunta, Segunda pergunta,
 *   Terceira faixa (0:00–0:15, 0:15–0:40, 0:40–1:00), Voz 1 asks and Voz 2 answers;
 * - a listener (who only listens: no voices, no editing, no bookmarks).
 *
 * Patched in the responses (`playerWorld`), besides the library's (`figmaWorld`): the term
 * list the transcripts were made with is dated 28/10/2026, as the frames have it (the server
 * stamps the day it was seeded).
 */

export const LISTENER = 'figma-ouvinte@kb-chat.test';
export const ALVARO = 'Mestre Álvaro Nunes';
export const SERGIO = 'Sérgio Andrade';
export const TERMS_AT = '2026-10-28T12:00:00.000Z';
export const DRAFT = [
  { startMs: 0, endMs: 15_000, title: 'Primeira pergunta' },
  { startMs: 15_000, endMs: 40_000, title: 'Segunda pergunta' },
  { startMs: 40_000, endMs: 60_000, title: 'Terceira faixa' },
] as const;

/** The noisy recording (TR_GR): two lines, both uncertain. */
const NOISY: readonly Line[] = [
  [0, 4.5, 'Trecho que talvez esteja errado.'],
  [5, 11, 'Outro trecho incerto da gravação.'],
];
/** "Leitura comentada do Caibalion" (TR_LC). */
const CAIBALION: readonly Line[] = [
  [0, 4.5, 'Abrimos o Caibalion no primeiro capítulo.'],
  [5, 9.5, 'O Todo é mente; o universo é mental.'],
  [10, 14.5, 'Essa é a chave para os outros princípios.'],
  [15, 19.5, 'Voltaremos a ela na próxima semana.'],
];
/** "Conversa sobre os sete princípios" (media-tracks-empty's transcript). */
const PRINCIPLES: readonly Line[] = [
  [0, 4.5, 'Os sete princípios começam pelo mentalismo.'],
  [5, 9.5, 'Depois vêm a correspondência e a vibração.'],
  [10, 14.5, 'A polaridade e o ritmo andam juntos.'],
  [15, 19.5, 'Por fim, causa e efeito, e o gênero.'],
];
const LINES = { ES: MINUTE, LC: CAIBALION, GR: NOISY, CS: PRINCIPLES };

/** The interview's bookmarks in the frames (BM3). */
const BOOKMARKS = [
  { positionMs: 5_000, note: 'O dia da sessão' },
  { positionMs: 22_000, note: 'Quem o levou: um amigo da construção' },
  { positionMs: 45_000 },
] as const;

async function speaker(
  owner: APIRequestContext,
  name: string,
): Promise<string> {
  const made = await owner.post(`/api/v1/topics/${TOPIC}/speakers`, {
    headers: CSRF,
    data: { name },
  });
  expect(made.status(), await made.text()).toBe(201);
  return ((await made.json()) as { id: string }).id;
}

/** The voice heard at `startMs`, as the separation numbered it. */
async function voiceAt(
  owner: APIRequestContext,
  mediaId: string,
  startMs: number,
): Promise<number> {
  const read = await owner.get(`/api/v1/media/${mediaId}/transcript`);
  const { segments } = (await read.json()) as {
    segments: { startMs: number; voice?: number | null }[];
  };
  const voice = segments.find((one) => one.startMs >= startMs)?.voice;
  expect(voice, `a voice at ${startMs} ms`).toEqual(expect.any(Number));
  return voice ?? 0;
}

/** Separates the minute's voices; with names, the two speakers and the audience. */
async function voices(
  owner: APIRequestContext,
  mediaId: string,
  names: { alvaro: string; sergio: string } | null,
): Promise<void> {
  await separateVoices(owner, mediaId, { turns: TURNS });
  if (!names) return;
  const named = [
    [0, names.alvaro, false],
    [5_500, names.sergio, false],
    [40_500, null, true],
  ] as const;
  for (const [at, speakerId, audience] of named) {
    const voice = await voiceAt(owner, mediaId, at);
    const put = await owner.put(`/api/v1/media/${mediaId}/voices/${voice}`, {
      headers: CSRF,
      data: { version: 1, speakerId, audience },
    });
    expect(put.status(), await put.text()).toBe(200);
  }
}

async function beforeTracks(
  owner: APIRequestContext,
  byCode: Readonly<Record<string, string>>,
): Promise<void> {
  const names = {
    alvaro: await speaker(owner, ALVARO),
    sergio: await speaker(owner, SERGIO),
  };
  await voices(owner, byCode['ES'] ?? '', names);
  await voices(owner, byCode['PR'] ?? '', names);
  await voices(owner, byCode['RP'] ?? '', null);
}

interface Bookmark {
  readonly id: string;
  readonly positionMs: number;
  readonly note?: string | null;
}

/** The interview's three bookmarks in place of the library's four, once per server. */
async function interviewBookmarks(
  owner: APIRequestContext,
  w: World,
): Promise<boolean> {
  const es = w.byCode['ES'] ?? '';
  const listed = await owner.get(`/api/v1/media/${es}/bookmarks`);
  const items = ((await listed.json()) as { items: Bookmark[] }).items;
  if (items.some((one) => one.note === BOOKMARKS[0].note)) return false;
  for (const one of items) {
    const gone = await owner.delete(`/api/v1/media/${es}/bookmarks/${one.id}`, {
      headers: CSRF,
    });
    expect(gone.status(), await gone.text()).toBeLessThan(300);
  }
  for (const one of [
    ...BOOKMARKS.map((mark) => ({ code: 'ES', ...mark })),
    { code: 'RP', positionMs: 50_000 },
  ]) {
    const { code, ...mark } = one;
    const made = await owner.post(`/api/v1/media/${w.byCode[code]}/bookmarks`, {
      headers: CSRF,
      data: { id: randomUUID(), ...mark },
    });
    expect(made.status(), await made.text()).toBeLessThan(300);
  }
  return true;
}

/** "Roda de perguntas para validar" left as a draft on step 3, the frames' three tracks. */
export async function saveDraft(
  owner: APIRequestContext,
  w: World,
): Promise<void> {
  const id = w.byCode['RP'] ?? '';
  const edit = await owner.get(`/api/v1/media/${id}/edit`);
  const version = ((await edit.json()) as { version?: number }).version ?? 0;
  const saved = await owner.put(`/api/v1/media/${id}/edit`, {
    data: {
      step: 3,
      tracks: DRAFT.map((track) => ({
        ...track,
        id: randomUUID(),
        source: 'manual',
        kind: 'qa',
        askerVoice: 1,
        answererVoice: 2,
        askerSpeakerId: null,
        answererSpeakerId: null,
      })),
    },
    headers: { ...CSRF, 'if-match': `"${version}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

export interface PlayerWorld extends World {
  /** The recording's tracks as media (their own /midia/:id), in order. */
  readonly tracks: readonly string[];
  readonly listener: string;
}

let player: PlayerWorld | null = null;
/** Once per worker, on a fresh server (tools/inventory/servers.sh start). */
export { OWNER, TOPIC };
export const TRANSCRIBER_OFF = TRANSCRIBER_OFF_SINCE;

export async function seedPlayerWorld(): Promise<PlayerWorld> {
  if (player) return player;
  const w = await seedWorld({ lines: LINES, beforeTracks });
  const owner = await ownerApi();
  if (await interviewBookmarks(owner, w)) {
    await saveDraft(owner, w);
    await invite(owner, LISTENER, {
      topics: [TOPIC],
      features: ['search', 'media'],
    });
  }
  const library = await owner.get('/api/v1/media/library');
  const items = (
    (await library.json()) as {
      items: { id: string; tracks?: { id: string }[] }[];
    }
  ).items;
  const tracks = (
    items.find((one) => one.id === w.byCode['PR'])?.tracks ?? []
  ).map((one) => one.id);
  expect(tracks, 'the recording has its three tracks').toHaveLength(3);
  await owner.dispose();
  player = { ...w, tracks, listener: LISTENER };
  return player;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The library's patches, and the term list of 28/10/2026 on every transcript. */
export async function playerWorld(
  context: BrowserContext,
  w: PlayerWorld,
  options: { readonly queue?: boolean } = {},
): Promise<void> {
  await figmaWorld(context, w, options);
  // The player's own media (and a track's recording): "enviado em 09/11/2026".
  const ids = new Set([...Object.values(w.ids), ...w.tracks]);
  await context.route(
    /\/api\/v1\/media\/[0-9a-f-]{36}(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      if (!(response.headers()['content-type'] ?? '').includes('json'))
        return route.fulfill({ response });
      await route.fulfill({
        response,
        json: withUploadDate(await response.json(), ids),
      });
    },
  );
  await context.route('**/api/v1/media/*/transcript', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    if (!(response.headers()['content-type'] ?? '').includes('json'))
      return route.fulfill({ response });
    const body = (await response.json()) as Record<string, unknown>;
    const list = body['termList'];
    await route.fulfill({
      response,
      json: isRecord(list)
        ? { ...body, termList: { ...list, createdAt: TERMS_AT } }
        : body,
    });
  });
}

/* ---------- the browser side, shared by media-player-figma and media-prepare-figma ---------- */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
export type Width = 'desktop' | 'phone';
export const WIDTHS: readonly Width[] = ['desktop', 'phone'];
/** The app's one media element (the engine's hidden `<audio data-media-engine>`). */
export const MEDIA = '[data-media-engine]';

/** A browser context at a width, signed in as `email`, on the seeded world's patches. */
export async function contextAt(
  browser: Browser,
  width: Width,
  email = OWNER,
): Promise<{ context: BrowserContext; page: Page }> {
  const w = player;
  if (!w) throw new Error('seedPlayerWorld() first');
  const phone = width === 'phone';
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  await playerWorld(context, w, { queue: email === OWNER });
  await recentCollections(context, w, email);
  const page = await context.newPage();
  await fakeGoogle(page);
  await signIn(page.request, email);
  // The library as the frames have it: every collection, recent plays first, as a list.
  const reset = await page.request.put('/api/v1/media/preferences', {
    headers: CSRF,
    data: {
      librarySort: 'recently-played',
      libraryView: 'list',
      libraryFilters: {
        states: [],
        authors: [],
        topic: null,
        allTopics: true,
        subject: null,
      },
    },
  });
  expect(reset.status(), await reset.text()).toBe(200);
  return { context, page };
}

/** An in-app navigation (the router hears popstate): what plays keeps playing. */
export async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(history.state, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, path);
  await page.waitForURL((url) => `${url.pathname}${url.search}` === path);
}

const playing = (page: Page) =>
  page.evaluate(
    (selector) =>
      document.querySelector<HTMLMediaElement>(selector)?.paused === false,
    MEDIA,
  );

/** The interview plays from where it stopped (0:22), from its own page. */
export async function playInterview(page: Page, w: World): Promise<void> {
  await page.goto(`/midia/${w.byCode['ES']}`);
  await page
    .locator('main')
    .getByRole('button', { name: 'Tocar', exact: true })
    .first()
    .click();
  await expect.poll(() => playing(page)).toBe(true);
}

/** Every media element stopped where it is. */
export async function pauseAll(page: Page): Promise<void> {
  await page.evaluate(() =>
    document
      .querySelectorAll<HTMLMediaElement>('audio, video')
      .forEach((one) => one.pause()),
  );
}

export interface ShotOptions {
  readonly width: Width;
  /** Where what plays is put back (seconds). */
  readonly at?: number;
  /** Every scrolled box back at its top (the frames' first screen). */
  readonly top?: boolean;
}

/**
 * Saves the state as `<id>[@mobile].png`; what plays is put back on `at` seconds (the
 * interview's 0:22) just before.
 */
export async function shoot(
  page: Page,
  id: string,
  how: Width | ShotOptions,
): Promise<void> {
  const {
    width,
    at = 22,
    top = true,
  } = typeof how === 'string' ? { width: how } : how;
  if (!shots) return;
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  if (top)
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((node) => {
        if (node.scrollTop > 0) node.scrollTop = 0;
      }),
    );
  await page.waitForTimeout(300);
  if (width === 'desktop') await page.mouse.move(1, 1);
  await page.evaluate(
    ([selector, seconds]) => {
      const media = document.querySelector<HTMLMediaElement>(selector);
      if (media && !media.paused) media.currentTime = seconds + 0.05;
    },
    [MEDIA, at] as const,
  );
  await page.waitForTimeout(150);
  await page.screenshot({
    path: `${shots}/${id}${width === 'phone' ? '@mobile' : ''}.png`,
  });
}

export function shotsDone(): void {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
}

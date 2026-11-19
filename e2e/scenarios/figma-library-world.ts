import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '@playwright/test';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  WEB_ORIGIN,
  expect,
  invite,
  ownerApi,
  signIn,
} from '../specs/fixtures.js';
import { makeMp3 } from '../specs/media-helpers.js';

/**
 * The sample data of the v2 · Mídia — Biblioteca e lista frames (figma-recreation's
 * redesign/src/lib.js MEDIA, COLLECTIONS, CHATS and features/library.js), seeded on a FRESH
 * E2E server so the app shows what the frames show: the same collections, titles, authors,
 * durations, statuses, progress, bookmarks, conversations, AI spend and playing track.
 *
 * Seeded for real, through the API: the eleven media of "Alquimia Prática" (the fixture
 * vault's collection, its one document included), their authors, durations, transcripts
 * (the search hits at 0:40, "Baixa confiança"), the recording cut in three tracks, the stopped
 * preparation, the failed file, the listening progress, twelve bookmarks, "Cosmologia
 * Espiritual" and the two conversations. "Hermetismo" (22 documents, Mestre Laércio) and the
 * owner's spend (US$ 0,03 de 1,00) are the E2E server's own.
 *
 * Patched in the responses (`figmaWorld`), each because no API can set it:
 * - the E2E server's ten "Zz …" level collections (made for other specs) are left out of
 *   GET /api/v1/topics, and "Cosmologia Espiritual" has the frame's 6 documents (documents
 *   come from the kb vault, which no API writes);
 * - GET /api/v1/media/processing is the frame's queue (one to validate, one failed, one
 *   waiting with the transcriber off since 10/11 11:29, also in GET …/preparation-options),
 *   as the fidelity spec did, and
 *   GET /api/v1/media/preparations has "Aula para preparar" stopped at step 2 (a pipeline
 *   state: no transcriber or worker runs in the E2E server to stop it there);
 * - the media's "Enviado em" is the frame's 09/11/2026 (the server stamps the upload time);
 * - PUT …/progress is answered without saving: the frames are one still moment, and the
 *   interview playing in every shot would otherwise move its "parou em 0:22" on.
 * The browser's clock is not frozen: the research conversation is saved as the run starts
 * ("agora") and the search one on 12/11/2026.
 */

export const OWNER = OWNER_EMAIL;
/** The frames' collection of media (the fixture vault's `alquimia`, "Alquimia Prática"). */
export const TOPIC = 'alquimia';
export const TOPIC_TITLE = 'Alquimia Prática';
/** The collection with no media (collection-empty, list-empty): the fixture's Hermetismo. */
export const EMPTY = 'hermetismo';
export const HELENA_NAME = 'Irmã Helena Prado';
export const RECORDING = 'Perguntas e respostas de 2019';
export const UPLOADED_AT = '2026-11-09T15:00:00.000Z';
export const TRANSCRIBER_OFF_SINCE = '2026-11-10T14:29:00.000Z';
export const SEARCH_CHAT_AT = '2026-11-12T15:00:00.000Z';

export type Line = readonly [start: number, end: number, text: string];
/** The E2E interview minute (voices-helpers): "vegetal" at 0:40, the frames' search hits. */
export const MINUTE: readonly Line[] = [
  [0, 5, 'Mestre, o senhor está lembrado daquele dia?'],
  [5.5, 15, 'Eu lembro sim, foi numa sessão em mil novecentos e sessenta.'],
  [15.5, 22, 'E como foi que o senhor chegou lá?'],
  [22.5, 40, 'Cheguei pela mão de um amigo que trabalhava na construção.'],
  [40.5, 45, 'Uma pergunta da plateia sobre o vegetal.'],
  [45.5, 59, 'Respondo com alegria: o vegetal é a nossa comunhão.'],
];
/** "Tocando agora" at 0:22 shows the line before and the line heard (the frame's card). */
const INTERVIEW: readonly Line[] = [
  [0, 5, 'Mestre, o senhor está lembrado daquele dia?'],
  [5.5, 12, 'Eu lembro sim, foi numa sessão em mil novecentos e sessenta.'],
  [
    12.5,
    21.5,
    'A frase mais conhecida é esta: o que está em cima é como o que está embaixo.',
  ],
  [21.5, 40, 'Isso não é uma imagem poética. É um método.'],
  [40.5, 45, 'Uma pergunta da plateia sobre o vegetal.'],
  [45.5, 59, 'Respondo com alegria: o vegetal é a nossa comunhão.'],
];
/** A short media's speech: the first lines, cut to its length (no "vegetal"). */
const shortLines = (seconds: number): Line[] =>
  MINUTE.slice(0, 2).map(([start, end, text]) => [
    Math.min(start, seconds - 1),
    Math.min(end, seconds - 0.5),
    text,
  ]);

interface Media {
  readonly code: string;
  readonly title: string;
  readonly helena: boolean;
  readonly seconds: number;
  /** What the transcriber sent; null: nothing yet ("Aguardando o transcritor"). */
  readonly lines: readonly Line[] | null;
  readonly low?: boolean;
  readonly corrupt?: boolean;
  readonly preparedTo?: 2;
}

/** lib.js MEDIA, in the frames' order (recently played, then the rest as added). */
export const MEDIA: readonly Media[] = [
  {
    code: 'ES',
    title: 'Entrevista sobre a Tábua de Esmeralda',
    helena: true,
    seconds: 60,
    lines: INTERVIEW,
  },
  {
    code: 'PA',
    title: 'Palestra de abertura do ciclo',
    helena: true,
    seconds: 28,
    lines: shortLines(28),
  },
  {
    code: 'CS',
    title: 'Conversa sobre os sete princípios',
    helena: true,
    seconds: 20,
    lines: shortLines(20),
  },
  {
    code: 'RR',
    title: 'Relato da Rita sobre o encontro',
    helena: false,
    seconds: 16,
    lines: shortLines(16),
  },
  {
    code: 'AC',
    title: 'Arquivo corrompido da reunião',
    helena: false,
    seconds: 0,
    lines: null,
    corrupt: true,
  },
  {
    code: 'LC',
    title: 'Leitura comentada do Caibalion',
    helena: true,
    seconds: 20,
    lines: shortLines(20),
  },
  {
    code: 'AS',
    title: 'Aula ainda sem transcrição',
    helena: false,
    seconds: 18,
    lines: null,
  },
  {
    code: 'AP',
    title: 'Aula para preparar',
    helena: false,
    seconds: 60,
    lines: MINUTE,
    preparedTo: 2,
  },
  {
    code: 'RP',
    title: 'Roda de perguntas para validar',
    helena: false,
    seconds: 60,
    lines: MINUTE,
  },
  { code: 'PR', title: RECORDING, helena: true, seconds: 60, lines: MINUTE },
  {
    code: 'GR',
    title: 'Gravação ruidosa do encontro',
    helena: false,
    seconds: 12,
    lines: shortLines(12),
    low: true,
  },
];
export const TITLES = MEDIA.map((one) => one.title);
export const HELENA_COUNT = MEDIA.filter((one) => one.helena).length;
/** The recording's tracks (lib.js MEDIA[9].tracks): 0:15, 0:25 and 0:19. */
export const TRACKS = [
  { startMs: 0, endMs: 15_000, title: 'Como o senhor chegou à sessão?' },
  { startMs: 15_000, endMs: 40_000, title: 'Quem o levou até lá?' },
  {
    startMs: 40_000,
    endMs: 59_000,
    title: 'Pergunta da plateia sobre o vegetal',
  },
] as const;
/** Where the first three stopped (lib.js prog / cont): ES 0:22, PA 0:12, CS 0:09. */
export const PROGRESS: readonly (readonly [code: string, ms: number])[] = [
  ['CS', 9_000],
  ['PA', 12_000],
  ['ES', 22_000],
];
/** "Lista · 12 marcadores": twelve bookmarks, the playing interview's among them. */
const BOOKMARKS: readonly (readonly [code: string, ms: number])[] = [
  ['ES', 8_000],
  ['ES', 22_000],
  ['ES', 41_000],
  ['ES', 50_000],
  ['PA', 5_000],
  ['PA', 12_000],
  ['CS', 4_000],
  ['CS', 9_000],
  ['RP', 41_000],
  ['AP', 30_000],
  ['LC', 6_000],
  ['RR', 3_000],
];
/** lib.js CHATS. */
export const CHATS = {
  research: 'O que é a natureza sétupla?',
  search: 'O que diz a Lei do Ritmo',
} as const;

export interface World {
  readonly ids: Record<string, string>;
  /** Media id by its cover code (lib.js). */
  readonly byCode: Record<string, string>;
  /** The bytes of "Conversa sobre os sete princípios": sent again, a repeated file. */
  readonly repeated: string;
  readonly cosmologia: string;
  /** /midia without the library (media-list-*), on Alquimia Prática / on Hermetismo. */
  readonly lister: string;
  readonly emptyLister: string;
  /** The library with no media for them (media-library-empty-*). */
  readonly emptyReader: string;
  readonly emptyUploader: string;
}

/** What the transcriber sends for `lines` (the e2e transcript route's `raw`). */
export const rawOf = (
  lines: readonly Line[],
  seconds: number,
  low: boolean,
) => ({
  chunks: [
    {
      offset: 0,
      end: Math.max(seconds, 1),
      result: {
        segments: lines.map(([start, end, text]) => ({
          start,
          end,
          text: ` ${text}`,
          avg_logprob: low ? -1.1 : -0.2,
          compression_ratio: 1.3,
          no_speech_prob: 0.01,
          words: text.split(' ').map((word, index, all) => ({
            word: ` ${word}`,
            start: start + ((end - start) * index) / all.length,
            end: start + ((end - start) * (index + 1)) / all.length,
            probability: low ? 0.3 : 0.95,
          })),
        })),
      },
    },
  ],
});

async function upload(
  api: APIRequestContext,
  {
    topic,
    media,
    author,
    bytes,
  }: {
    readonly topic: string;
    readonly media: Media;
    readonly author: string | null;
    readonly bytes: Buffer;
  },
): Promise<string> {
  const created = await api.post(`/api/v1/topics/${topic}/media`, {
    data: {
      title: media.title,
      author,
      fileName: 'aula.mp3',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    headers: CSRF,
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const sent = await api.put(`/api/v1/media/${id}/file`, {
    data: bytes,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  });
  expect(sent.status(), await sent.text()).toBe(200);
  return id;
}

async function statusOf(api: APIRequestContext, id: string): Promise<string> {
  const read = await api.get(`/api/v1/media/${id}`);
  return ((await read.json()) as { status: string }).status;
}

/** The people of the frames, by fixed addresses: a second worker finds them again. */
const PEOPLE = {
  lister: 'figma-lista@kb-chat.test',
  emptyLister: 'figma-lista-vazia@kb-chat.test',
  emptyReader: 'figma-leitor-vazio@kb-chat.test',
  emptyUploader: 'figma-envia-vazio@kb-chat.test',
} as const;
/** "Conversa sobre os sete princípios"' bytes, kept for a later worker (media-upload-duplicate). */
const REPEATED = join(
  tmpdir(),
  `kbc-figma-repeated-${process.env['KBC_E2E_API_PORT'] ?? '3117'}.mp3`,
);

/** The world already seeded on this server (a second worker, a rerun), or null. */
async function seededWorld(owner: APIRequestContext): Promise<World | null> {
  const listed = await owner.get(`/api/v1/topics/${TOPIC}/media`);
  const items =
    ((await listed.json()) as { items?: { id: string; title: string }[] })
      .items ?? [];
  if (items.length === 0) return null;
  const ids: Record<string, string> = {};
  const byCode: Record<string, string> = {};
  for (const media of MEDIA) {
    const found = items.find((one) => one.title === media.title);
    expect(
      found,
      `"${media.title}" is not on this server: start a fresh one (servers.sh start)`,
    ).toBeDefined();
    ids[media.title] = found?.id ?? '';
    byCode[media.code] = found?.id ?? '';
  }
  const topics = (await (await owner.get('/api/v1/topics')).json()) as {
    items: { slug: string; title: string }[];
  };
  const cosmologia =
    topics.items.find((one) => one.title === 'Cosmologia Espiritual')?.slug ??
    '';
  return { ids, byCode, repeated: REPEATED, cosmologia, ...PEOPLE };
}

/** What another area's world adds to this one (figma-player-world.ts), as it is seeded. */
export interface SeedOptions {
  /** The transcript a media gets in place of its MEDIA lines, by its cover code. */
  readonly lines?: Readonly<Record<string, readonly Line[]>>;
  /** Runs after the transcripts, before the recording's tracks are cut and approved. */
  readonly beforeTracks?: (
    owner: APIRequestContext,
    byCode: Readonly<Record<string, string>>,
  ) => Promise<void>;
}

/** Once per worker; seeds a fresh server (tools/inventory/servers.sh start), else finds it. */
let world: World | null = null;
export async function seedWorld(options: SeedOptions = {}): Promise<World> {
  if (world) return world;
  const owner = await ownerApi();
  const found = await seededWorld(owner);
  if (found) {
    await owner.dispose();
    world = found;
    return found;
  }

  const author = await owner.post(`/api/v1/topics/${TOPIC}/authors`, {
    headers: CSRF,
    data: { name: HELENA_NAME },
  });
  expect(author.status(), await author.text()).toBeLessThan(300);
  const helena = ((await author.json()) as { slug: string }).slug;
  // "Mestre Laércio e outros autores" (media-list's header): the collection's main author.
  const laercio = await owner.post(`/api/v1/topics/${TOPIC}/authors`, {
    headers: CSRF,
    data: { name: 'Mestre Laércio' },
  });
  expect(laercio.status(), await laercio.text()).toBeLessThan(300);
  const main = await owner.patch(`/api/v1/topics/${TOPIC}`, {
    headers: CSRF,
    data: { mainAuthor: ((await laercio.json()) as { slug: string }).slug },
  });
  expect(main.status(), await main.text()).toBeLessThan(300);

  const made = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: 'Cosmologia Espiritual' },
  });
  expect(made.status(), await made.text()).toBe(201);
  const cosmologia = ((await made.json()) as { slug: string }).slug;

  const listing = ['search', 'media', 'media-upload', 'media-edit'];
  const lister = PEOPLE.lister;
  // The /midia frames draw the recording's "3 faixas" (media-list@mobile): who lists sees tracks.
  await invite(owner, lister, {
    topics: [TOPIC],
    features: [...listing, 'media-tracks'],
  });
  const listerApi = await request.newContext({ baseURL: WEB_ORIGIN });
  await signIn(listerApi, lister);

  // Oldest first: the three played ones (MEDIA's first three, Conversa the oldest), then the
  // rest, so that newest added first gives the frames' order: the library's unplayed ones
  // (media-library) and the album as sent, the played ones last (media-list).
  const ids: Record<string, string> = {};
  const byCode: Record<string, string> = {};
  copyFileSync(makeMp3('figma-repetida', 20), REPEATED);
  const repeated = REPEATED;
  const played = MEDIA.slice(0, 3);
  for (const media of [...played.reverse(), ...MEDIA.slice(3).reverse()]) {
    const bytes = media.corrupt
      ? Buffer.from('not an audio file at all, only words'.repeat(40))
      : media.code === 'CS'
        ? readFileSync(repeated)
        : readFileSync(makeMp3(`figma-${media.code}`, media.seconds));
    // "Relato da Rita…" is the lister's own: on /midia its ⋯ edits it (media-list-menu).
    const api = media.code === 'RR' ? listerApi : owner;
    const id = await upload(api, {
      topic: TOPIC,
      media,
      author: media.helena ? helena : null,
      bytes,
    });
    ids[media.title] = id;
    byCode[media.code] = id;
  }
  for (const id of Object.values(ids))
    await expect
      .poll(() => statusOf(owner, id), { timeout: 120_000 })
      .toMatch(/^(ready|failed)$/);

  for (const media of MEDIA) {
    const lines = options.lines?.[media.code] ?? media.lines;
    if (!lines) continue;
    const seeded = await owner.post(
      `/api/e2e/media/${byCode[media.code]}/transcript`,
      {
        data: { raw: rawOf(lines, media.seconds, !!media.low) },
        headers: CSRF,
      },
    );
    expect(seeded.status(), `${media.code}: ${await seeded.text()}`).toBe(204);
  }

  await options.beforeTracks?.(owner, byCode);

  // The recording, cut in its three tracks, approved and published (KBC-068).
  const recording = byCode['PR'] ?? '';
  const draft = await owner.put(`/api/v1/media/${recording}/edit`, {
    data: {
      step: 3,
      tracks: TRACKS.map((track) => ({
        ...track,
        id: randomUUID(),
        source: 'manual',
        kind: 'qa',
        askerVoice: null,
        answererVoice: null,
        askerSpeakerId: null,
        answererSpeakerId: null,
      })),
    },
    headers: { ...CSRF, 'if-match': '"0"' },
  });
  expect(draft.status(), await draft.text()).toBe(200);
  const approved = await owner.post(`/api/v1/media/${recording}/edit/approve`, {
    data: {},
    headers: { ...CSRF, 'if-match': '"1"' },
  });
  expect(approved.status(), await approved.text()).toBe(200);
  await expect
    .poll(
      async () =>
        (
          (await (
            await owner.get(`/api/v1/media/${recording}/edit`)
          ).json()) as {
            preparation: unknown;
          }
        ).preparation,
      { timeout: 60_000 },
    )
    .toBeNull();

  // Where the owner stopped in the first three (the last saved is the most recent play).
  for (const [code, ms] of PROGRESS) {
    const saved = await owner.put(`/api/v1/media/${byCode[code]}/progress`, {
      data: { positionMs: ms, basedOn: null },
      headers: CSRF,
    });
    expect(saved.status(), await saved.text()).toBe(200);
  }
  for (const [code, positionMs] of BOOKMARKS) {
    const marked = await owner.post(`/api/v1/media/${byCode[code]}/bookmarks`, {
      headers: CSRF,
      data: { id: randomUUID(), positionMs },
    });
    expect(marked.status(), await marked.text()).toBeLessThan(300);
  }
  // The /midia frames are the lister's, and draw the playing interview's filled 🔖
  // (media-list, media-list@mobile). Not its positions: they would reorder the phone's list.
  for (const [code, positionMs] of BOOKMARKS.filter(
    ([code]) => code === 'ES',
  )) {
    const marked = await listerApi.post(
      `/api/v1/media/${byCode[code]}/bookmarks`,
      { headers: CSRF, data: { id: randomUUID(), positionMs } },
    );
    expect(marked.status(), await marked.text()).toBeLessThan(300);
  }

  // The two conversations of "Sua biblioteca": the research now, the search on 12/11.
  const now = new Date().toISOString();
  const chats = [
    {
      kind: 'search',
      id: randomUUID(),
      topic: EMPTY,
      title: CHATS.search,
      createdAt: SEARCH_CHAT_AT,
      updatedAt: SEARCH_CHAT_AT,
      asks: [{ question: CHATS.search, mode: 'all', filters: {}, total: 3 }],
    },
    {
      kind: 'research',
      id: randomUUID(),
      topic: EMPTY,
      title: CHATS.research,
      createdAt: now,
      updatedAt: now,
      turns: [
        {
          question: CHATS.research,
          answer: 'A natureza sétupla é a divisão do ser em sete planos.',
          sources: [],
          steps: 1,
          usd: 0.03,
          billing: 'per-token',
          model: 'stub',
          interrupted: false,
          at: now,
        },
      ],
    },
  ];
  for (const chat of chats) {
    const saved = await owner.put(`/api/v1/conversations/${chat.id}`, {
      data: chat,
      headers: CSRF,
    });
    expect(saved.status(), await saved.text()).toBe(200);
  }

  const { emptyLister, emptyReader, emptyUploader } = PEOPLE;
  await invite(owner, emptyLister, { topics: [EMPTY], features: listing });
  await invite(owner, emptyReader, {
    topics: [EMPTY],
    features: ['search', 'media', 'media-library'],
  });
  await invite(owner, emptyUploader, {
    topics: [EMPTY],
    features: ['search', 'media', 'media-library', 'media-upload'],
  });
  await owner.dispose();
  await listerApi.dispose();
  world = {
    ids,
    byCode,
    repeated,
    cosmologia,
    lister,
    emptyLister,
    emptyReader,
    emptyUploader,
  };
  return world;
}

/** The frame's queue: one to validate, one failed, one waiting for the transcriber. */
function queueOf(w: World) {
  const line = (code: string, over: Record<string, unknown>) => {
    const media = MEDIA.find((one) => one.code === code);
    return {
      mediaId: w.byCode[code],
      title: media?.title ?? code,
      topic: TOPIC,
      phase: 'attention',
      stage: 'transcribe',
      state: 'waiting',
      percent: null,
      cuts: null,
      windows: null,
      failure: null,
      blockedBy: null,
      position: null,
      nextStage: null,
      waitsForTranscriber: false,
      canUseGroq: false,
      durationMs: (media?.seconds ?? 0) * 1000,
      action: null,
      retryStage: null,
      step: 2,
      ...over,
    };
  };
  return {
    items: [
      line('AP', { action: 'validate', stage: 'tracks' }),
      line('AC', { state: 'failed', failure: 'work', stage: 'convert' }),
      line('AS', { state: 'waiting', waitsForTranscriber: true }),
    ],
    active: 0,
    transcriber: 'off',
    transcriberOffSince: TRANSCRIBER_OFF_SINCE,
  };
}

/** LibraryRecents' key: FNV-1a of the address (apps/web/src/app/features/shell/library-recents.ts). */
function recentsKey(email: string): string {
  let hash = 0x811c9dc5;
  for (const char of email.toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `kb-chat.library-recents:${(hash >>> 0).toString(36)}`;
}

/**
 * "Sua biblioteca" in the frames' "Recentes" order (Hermetismo, Alquimia Prática, Cosmologia
 * Espiritual): when each collection was last chosen is kept in the browser only.
 */
export async function recentCollections(
  context: BrowserContext,
  w: World,
  email: string,
): Promise<void> {
  const now = Date.now();
  const recents = {
    collections: {
      [EMPTY]: now - 60_000,
      [TOPIC]: now - 120_000,
      [w.cosmologia]: now - 180_000,
    },
    documents: [],
  };
  await context.addInitScript(
    ([key, value]) => {
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      } catch {
        // No storage: the list keeps the server's order.
      }
    },
    [recentsKey(email), JSON.stringify(recents)] as const,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every media object of a response gets the frames' upload date (09/11/2026), keeping the
 * order they were sent in (the minutes and seconds of the hour they were seeded in): the
 * album page goes as sent, newest first (media-list).
 */
export function withUploadDate(
  value: unknown,
  ids: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) return value.map((one) => withUploadDate(one, ids));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(value))
    out[key] = withUploadDate(one, ids);
  const dated = typeof out['id'] === 'string' && ids.has(out['id']);
  const keys = ['createdAt', 'uploadedAt', 'addedAt'].filter(
    (key) => dated && typeof out[key] === 'string',
  );
  for (const key of keys)
    out[key] = new Date(
      Date.parse(UPLOADED_AT) + (Date.parse(String(out[key])) % 3_600_000),
    ).toISOString();
  return out;
}

/**
 * The response patches listed in the header, on a browser context. `queue: false` leaves the
 * real processing queue (the states where the frame has none).
 */
export async function figmaWorld(
  context: BrowserContext,
  w: World,
  { queue = true }: { readonly queue?: boolean } = {},
): Promise<void> {
  const ids = new Set(Object.values(w.ids));
  await context.route(/\/api\/v1\/topics(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
    };
    body.items = body.items
      .filter((topic) => !String(topic['slug']).startsWith('zz-'))
      .map((topic) =>
        topic['slug'] === w.cosmologia ? { ...topic, documentCount: 6 } : topic,
      );
    await route.fulfill({ response, json: body });
  });
  if (queue) {
    await context.route('**/api/v1/media/processing', (route) =>
      route.fulfill({ json: queueOf(w) }),
    );
    // The transcriber is off since 10/11 11:29 for the upload panel's options too.
    await context.route(
      '**/api/v1/media/preparation-options*',
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
          response,
          json: {
            ...body,
            transcriber: 'off',
            transcriberOffSince: TRANSCRIBER_OFF_SINCE,
          },
        });
      },
    );
  }
  // "Aula para preparar" stopped at step 2, for whoever may go on with it (media-list too).
  await context.route('**/api/v1/media/preparations', (route) =>
    route.fulfill({
      json: { items: [{ mediaId: w.byCode['AP'], step: 2 }] },
    }),
  );
  await context.route('**/api/v1/media/*/progress', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const asked = route.request().postDataJSON() as { positionMs: number };
    await route.fulfill({
      json: {
        positionMs: asked.positionMs,
        completedAt: null,
        positionUpdatedAt: new Date().toISOString(),
      },
    });
  });
  await context.route(
    /\/api\/v1\/(topics\/[^/]+\/media|media\/library)(\?.*)?$/,
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
}

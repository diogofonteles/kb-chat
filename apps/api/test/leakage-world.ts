/**
 * The sentinel world of the leakage suite (KBC-111, ADR 0036 §12): QS < CI < CDC in
 * `hermetismo`, and items at CDC whose titles, ids and texts carry the mark `zqx`. Ana holds
 * CI, with every feature a member can hold; she saved, bookmarked and played some of them
 * while she was at CDC. The twin (`sentinels: false`) is the same collection without them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { MediaItem } from '@kb-chat/contracts';
import { GRANTABLE_FEATURES } from '@kb-chat/contracts';
import { expect } from 'vitest';
import type { StubLlmAdapter } from '../src/adapters/stub-llm-adapter.js';
import type { Call, StartOptions } from './ai-app-harness.js';
import {
  SIX,
  createScale,
  doc,
  memberOf,
  placeDocuments,
  setPersonLevel,
  startLevels,
  type LevelsWorld,
} from './levels-world.js';
import { leaseJob, upload, type Media } from './media-harness.js';
import {
  approve,
  convertLong,
  finishCuts,
  libraryEntry,
  say,
  type Bounds,
} from './track-items-harness.js';
import {
  mediaOf,
  packetAt,
  realRendition,
  renditionPath,
  transcriber,
} from './track-levels-world.js';

/** What every hidden title, id and text carries: one of these in Ana's bytes is a leak. */
export const MARK = 'zqx';

/**
 * The second mark (review IMP-1/2): in every hidden title, passage, subject, summary and in
 * the hidden audio bytes, and never in anything the probe sends. It is looked for with no
 * echo taken out, and the master's control counts only it.
 */
export const SECRET = 'qvk';

/** Each hidden item's second mark: the master must receive every one of them. */
export const SECRETS = [
  'qvkraiztitulo',
  'qvkraizcorpo',
  'qvkaulatitulo',
  'qvkaulacorpo',
  'qvkconceito',
  'qvkcopia',
  'qvkgravacao',
  'qvkgravfala',
  'qvkgravsom',
  'qvkfaixa',
  'qvkfala',
  'qvkfaixasom',
  'qvkassunto',
  'qvkresumo',
] as const;

/** Visible to Ana: a copy group's open member and a text linking to a hidden concept. */
const BRIDGES = [
  doc('hermetismo/raw/tabua.md', 'Tábua de Esmeralda', 'A lua da tábua.'),
  doc('hermetismo/raw/ligado.md', 'Texto Ligado', {
    body: 'A lua do meio, ligada.',
    extra: 'related: ["[[Zqxconceito]]", "[[Lua Primeira Aberta]]"]',
  }),
];

/** At CDC: a text at the root and one in the sub-collection, a concept and a copy. */
const SENTINELS = [
  doc(
    'hermetismo/raw/zqx-raiz.md',
    'Zqxraiz Velado Qvkraiztitulo',
    'A lua no zqxcorpo da raiz qvkraizcorpo.',
  ),
  doc(
    'hermetismo/aulas/raw/zqx-aula.md',
    'Zqxaula Velada Qvkaulatitulo',
    'A lua na zqxaula velada qvkaulacorpo.',
  ),
  doc(
    'hermetismo/wiki/concepts/Zqxconceito.md',
    'Zqxconceito',
    'A lua zqxv qvkconceito.',
  ),
  doc(
    'hermetismo/raw/zqx-copia.md',
    'Tábua de Esmeralda',
    'A lua zqxcopia qvkcopia.',
  ),
];

/** Their keys for the level writes and their ids as routes take them. */
export const SENTINEL_DOCS = [
  {
    key: 'hermetismo:raw/zqx-raiz.md',
    topic: 'hermetismo',
    id: 'raw/zqx-raiz.md',
  },
  {
    key: 'hermetismo/aulas:raw/zqx-aula.md',
    topic: 'hermetismo/aulas',
    id: 'raw/zqx-aula.md',
  },
  {
    key: 'hermetismo:wiki/concepts/Zqxconceito.md',
    topic: 'hermetismo',
    id: 'wiki/concepts/Zqxconceito.md',
  },
  {
    key: 'hermetismo:raw/zqx-copia.md',
    topic: 'hermetismo',
    id: 'raw/zqx-copia.md',
  },
] as const;

export const OPEN_DOC_IDS = [
  'raw/tabua.md',
  'raw/ligado.md',
  'raw/qs-1.md',
  'raw/ci-1.md',
];

/** The CI recording: its second track goes to CDC with a marked title and passage. */
const OPEN_PASSAGES = [
  { at: 10, text: 'lua aberta do comeco' },
  { at: 70, text: 'zqxfala da faixa velada qvkfala' },
  { at: 130, text: 'lua final da palestra' },
];
const TWIN_PASSAGES = [OPEN_PASSAGES[0], OPEN_PASSAGES[2]].flatMap((one) =>
  one ? [one] : [],
);
const TRACKS: readonly Bounds[] = [
  { startMs: 0, endMs: 60_000, title: 'Primeira' },
  {
    startMs: 60_000,
    endMs: 120_000,
    title: 'Zqxfaixa Velada Qvkfaixa',
    level: 'cdc',
  },
  { startMs: 120_000, endMs: 180_000, title: 'Terceira' },
];
const TWIN_TRACKS = [TRACKS[0], TRACKS[2]].flatMap((one) => (one ? [one] : []));

/** The bytes of the hidden recording: its duplicate is what Ana sends in the AC-5 check. */
export const HIDDEN_AUDIO = Buffer.from('ID3 zqx qvkgravsom recording bytes');
export const HIDDEN_SHA = createHash('sha256')
  .update(HIDDEN_AUDIO)
  .digest('hex');
const OPEN_AUDIO = Buffer.from('ID3 open recording bytes of the talk');

export const ANA_FEATURES = GRANTABLE_FEATURES.filter(
  (feature) => feature !== 'collection-create',
);

export interface Person {
  readonly call: Call;
  readonly id: string;
  readonly headers: Record<string, string>;
}

export interface LeakageWorld {
  readonly world: LevelsWorld;
  readonly ana: Person;
  /** The CI recording and its live tracks as the master sees them. */
  readonly recording: MediaItem;
  readonly tracks: readonly MediaItem[];
  /** Only with sentinels: the CDC recording, the CDC track, Ana's saved conversation. */
  readonly hidden: {
    readonly recording: string;
    readonly track: string;
  } | null;
  readonly conversation: string | null;
  readonly bookmark: string | null;
}

interface RecordingInput {
  readonly title: string;
  readonly level: string;
  readonly body: Buffer;
  readonly passages: readonly { at: number; text: string }[];
}

/** A recording sent by the master, converted and transcribed by the world's Mac. */
async function recorded(
  media: Media,
  token: string,
  input: RecordingInput,
): Promise<MediaItem> {
  const created = await media.owner('POST', '/api/v1/topics/hermetismo/media', {
    title: input.title,
    author: null,
    fileName: 'palestra.mp3',
    bytes: input.body.length,
    sha256: createHash('sha256').update(input.body).digest('hex'),
    level: input.level,
  });
  expect(created.statusCode, created.body).toBe(201);
  const item: MediaItem = created.json();
  const sent = await upload(media, { id: item.id, body: input.body });
  expect(sent.statusCode, sent.body).toBe(200);
  await convertLong(media, await leaseJob(media));
  await say({ media, token }, input.passages);
  return item;
}

const DOC_LEVELS: Readonly<Record<string, string>> = {
  'hermetismo:raw/ci-1.md': 'ci',
  'hermetismo/aulas:raw/ci-2.md': 'ci',
  'hermetismo:raw/cdc-1.md': 'qs',
  'hermetismo:raw/cdc-2.md': 'qs',
  'hermetismo:raw/ligado.md': 'ci',
};

const SAVED_AT = '2026-11-12T12:00:00.000Z';

/** An open text and the hidden one, as the answer cited them while Ana was at CDC. */
const CITED = [
  {
    n: 1,
    id: 'raw/qs-1.md',
    title: 'Lua Primeira Aberta',
    authorship: 'outros-autores',
  },
  {
    n: 2,
    id: 'raw/zqx-raiz.md',
    title: 'Zqxraiz Velado Qvkraiztitulo',
    authorship: 'outros-autores',
    author: 'Zqxautor Qvkautor',
  },
];

/** A research answer citing an open text and the hidden one (KBC-110 re-checks it at read). */
const answerCitingHidden = (id: string) => ({
  kind: 'research',
  id,
  topic: 'hermetismo',
  title: 'o que dizem da lua?',
  createdAt: SAVED_AT,
  updatedAt: SAVED_AT,
  turns: [
    {
      id: randomUUID(),
      question: 'o que dizem da lua?',
      answer: 'A lua aparece em dois graus [1] [2].',
      sources: CITED,
      steps: 2,
      usd: 0,
      billing: 'subscription',
      model: 'stub/model',
      interrupted: false,
      at: SAVED_AT,
    },
  ],
});

/** Ana bookmarks the hidden recording and plays it (recents, progress). */
async function bookmarkAndPlay(
  ana: Person,
  recording: string,
): Promise<string> {
  const bookmark = randomUUID();
  const marked = await ana.call(
    'POST',
    `/api/v1/media/${recording}/bookmarks`,
    {
      id: bookmark,
      positionMs: 5_000,
      note: 'zqxnota qvknota',
    },
  );
  expect(marked.statusCode, marked.body).toBe(201);
  const played = await ana.call('PUT', `/api/v1/media/${recording}/progress`, {
    positionMs: 6_000,
    basedOn: null,
  });
  expect(played.statusCode, played.body).toBe(200);
  return bookmark;
}

/** Ana, while still at CDC, saves an answer citing a hidden text, bookmarks and plays audio. */
async function anaActsAtCdc(
  world: LevelsWorld,
  ana: Person,
  hiddenRecording: string,
): Promise<{ conversation: string; bookmark: string }> {
  await setPersonLevel(world, ana.id, { hermetismo: 'cdc' });
  const conversation = randomUUID();
  const saved = await ana.call(
    'PUT',
    `/api/v1/conversations/${conversation}`,
    answerCitingHidden(conversation),
  );
  expect(saved.statusCode, saved.body).toBe(200);
  const bookmark = await bookmarkAndPlay(ana, hiddenRecording);
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  return { conversation, bookmark };
}

interface WorldOptions {
  readonly sentinels: boolean;
  readonly llm?: StubLlmAdapter;
  readonly routes?: StartOptions['routes'];
}

/** The documents placed on the scale, and Ana at CI with every member feature. */
async function scaledDocuments(options: WorldOptions) {
  const docs = [...SIX, ...BRIDGES, ...(options.sentinels ? SENTINELS : [])];
  const world = await startLevels(docs, {
    media: true,
    ...(options.llm && { llm: options.llm }),
    ...(options.routes && { routes: options.routes }),
  });
  const ana = await memberOf(world, 'ana@example.com', {
    topics: ['hermetismo'],
    features: [...ANA_FEATURES],
  });
  await createScale(world, ['QS', 'CI', 'CDC']);
  await placeDocuments(world, {
    ...DOC_LEVELS,
    ...(options.sentinels &&
      Object.fromEntries(SENTINEL_DOCS.map((one) => [one.key, 'cdc']))),
  });
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  return { world, ana };
}

/** The CI recording cut in tracks (the second at CDC with sentinels; absent in the twin). */
async function openRecording(media: Media, token: string, sentinels: boolean) {
  const recording = await recorded(media, token, {
    title: 'Palestra Aberta',
    level: 'ci',
    body: OPEN_AUDIO,
    passages: sentinels ? OPEN_PASSAGES : TWIN_PASSAGES,
  });
  await approve(media, recording.id, sentinels ? TRACKS : TWIN_TRACKS);
  await finishCuts(media);
  const tracks = (await libraryEntry(media.owner, recording.id))?.tracks ?? [];
  return { recording, tracks };
}

/**
 * The audio as the worker leaves it, with the second mark where Ana must not hear: real AAC
 * for the open recording with marks inside the CDC track's frames (only the silent frames of
 * the mask take them out), and marked bytes in the CDC track's cut and the CDC recording.
 */
function markAudio(
  world: LevelsWorld,
  open: string,
  hidden: { readonly recording: string; readonly track: string },
): void {
  const path = realRendition(world, open);
  const frames = [65, 80, 95, 110].map((seconds) => packetAt(path, seconds));
  const file = readFileSync(path);
  for (const at of frames) file.write('qvkfaixasom', at + 4);
  writeFileSync(path, file);
  writeFileSync(
    renditionPath(world, hidden.track),
    Buffer.from('cut of qvkfaixasom'),
  );
  writeFileSync(renditionPath(world, hidden.recording), HIDDEN_AUDIO);
}

/** The master gives the CDC track a subject and a summary, both marked. */
async function describeHiddenTrack(world: LevelsWorld, track: string) {
  const subject = await world.owner(
    'POST',
    '/api/v1/topics/hermetismo/subjects',
    { name: 'Qvkassunto' },
  );
  expect(subject.statusCode, subject.body).toBe(201);
  const url = `/api/v1/media/${track}/subjects`;
  const read = await world.owner('GET', url);
  expect(read.statusCode, read.body).toBe(200);
  const saved = await world.started.app.inject({
    method: 'PUT',
    url,
    headers: {
      ...world.ownerHeaders,
      'if-match': `"${read.json<{ version: number }>().version}"`,
    },
    payload: {
      subjects: [{ kind: 'free', id: subject.json<{ id: string }>().id }],
      summary: 'Resumo qvkresumo da faixa.',
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

/**
 * The world: SIX (the CDC pair of SIX placed at QS, so every hidden item here is marked), the
 * bridges, and with `sentinels` the marked items at CDC and Ana's acts on them.
 */
export async function leakageWorld(
  options: WorldOptions,
): Promise<LeakageWorld> {
  const { world, ana } = await scaledDocuments(options);
  const media = mediaOf(world);
  const token = await transcriber(media);
  const open = await openRecording(media, token, options.sentinels);
  const nothing = { hidden: null, conversation: null, bookmark: null };
  if (!options.sentinels) return { world, ana, ...open, ...nothing };
  const hiddenRecording = await recorded(media, token, {
    title: 'Zqxgravacao Velada Qvkgravacao',
    level: 'cdc',
    body: HIDDEN_AUDIO,
    passages: [{ at: 20, text: 'lua zqxgravfala velada qvkgravfala' }],
  });
  const acts = await anaActsAtCdc(world, ana, hiddenRecording.id);
  const track = open.tracks.find((one) => one.title.startsWith('Zqxfaixa'));
  if (!track) throw new Error('the CDC track is missing');
  const hidden = { recording: hiddenRecording.id, track: track.id };
  markAudio(world, open.recording.id, hidden);
  await describeHiddenTrack(world, track.id);
  return { world, ana, ...open, hidden, ...acts };
}

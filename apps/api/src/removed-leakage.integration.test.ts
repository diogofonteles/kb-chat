import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BODIES,
  UNKNOWN_BOOKMARK,
  UNKNOWN_DOCUMENT,
  UNKNOWN_MEDIA,
  exchange,
  leaksIn,
  requestsOf,
  routesOf,
  type Candidates,
  type Exchange,
  type Send,
} from '../test/leakage-probe.js';
import {
  OPEN_DOC_IDS,
  SENTINEL_DOCS,
  leakageWorld,
  type LeakageWorld,
} from '../test/leakage-world.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

/*
 * KBC-187 BR-2: what was taken out of its collection reaches nobody, the owner included, by
 * any route that reads or any answer of the research, before and after the Mac moves it. The
 * probe is the levels' (KBC-111): every route the app registered, with every candidate.
 */

const SUB_ID = 'aulas/raw/zqx-aula.md';
/** One of the collection, with a kept original; one of a sub-collection; one of a group of copies. */
const GONE = [
  { topic: 'hermetismo', id: 'raw/zqx-raiz.md', asked: 'raw/zqx-raiz.md' },
  { topic: 'hermetismo/aulas', id: 'raw/zqx-aula.md', asked: SUB_ID },
  { topic: 'hermetismo', id: 'raw/zqx-copia.md', asked: 'raw/zqx-copia.md' },
];
const MARKS = [
  'qvkraiztitulo',
  'qvkraizcorpo',
  'qvkaulatitulo',
  'qvkaulacorpo',
  'qvkcopia',
];

const call = (name: string, args: Record<string, unknown>): StubReply => ({
  toolCalls: [{ name, arguments: args }],
});

/** The research model reaches for each of them by name, id and word. */
const LOOKING: readonly StubReply[] = [
  call('search_collection', { query: 'zqxcorpo zqxaula', mode: 'all' }),
  call('find_text', { phrase: 'zqxcorpo', output_mode: 'content' }),
  call('list_sources', {}),
  call('read_documents', { documents: GONE.map(({ asked }) => asked) }),
  { text: 'Segundo o acervo, nada [1].' },
];

const candidates: Candidates = {
  documents: [
    ...SENTINEL_DOCS.map((doc) => doc.id),
    SUB_ID,
    ...OPEN_DOC_IDS,
    UNKNOWN_DOCUMENT,
  ],
  media: [UNKNOWN_MEDIA],
  conversations: [],
  bookmarks: [UNKNOWN_BOOKMARK],
  unknownOf: new Map(),
  bodies: [{ uuid: UNKNOWN_MEDIA, document: UNKNOWN_DOCUMENT }],
};

const sender =
  (app: FastifyInstance, headers: Record<string, string>): Send =>
  (request) =>
    app.inject({
      method: request.method,
      url: request.url,
      headers,
      ...(request.payload && { payload: request.payload }),
    });

let world: LeakageWorld;
let before: Exchange[];
let hidden: Exchange[];
let moved: Exchange[];

beforeAll(async () => {
  const llm = new StubLlmAdapter({ script: [...LOOKING] });
  world = await leakageWorld({ sentinels: true, llm });
  const { started, ownerHeaders, owner, vault } = world.world;
  const read = () =>
    exchange(
      sender(started.app, ownerHeaders),
      routesOf(started.app)
        .filter(
          ({ route }) =>
            (route.startsWith('GET ') || BODIES[route] !== undefined) &&
            // Where masters see what they took out, by its title.
            !route.includes('/document-removals'),
        )
        .flatMap((route) => requestsOf(route, candidates, BODIES)),
      llm,
    );
  before = await read();
  for (const { asked } of GONE) {
    const url = `/api/v1/topics/hermetismo/documents/${encodeURIComponent(asked)}/removal`;
    const removed = await owner('POST', url);
    expect(removed.statusCode, removed.body).toBe(200);
  }
  hidden = await read();
  for (const { topic, id } of GONE) {
    const from = join(vault, topic, id);
    const to = join(vault, topic, id.replace('raw/', 'raw/_quarantine/'));
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }
  await started.catalog.load();
  moved = await read();
}, 300_000);

afterAll(() => world.world.started.app.close());

const textOf = (exchanges: readonly Exchange[]) =>
  exchanges.map(({ text }) => text).join('\n');

describe('what was taken out of its collection (KBC-187 BR-2)', () => {
  it('was all there before (the probe reaches it)', () => {
    const text = textOf(before).toLowerCase();
    expect(MARKS.filter((mark) => !text.includes(mark))).toEqual([]);
  });

  it('reaches nobody before the Mac moves it', () => {
    expect(leaksIn(hidden, MARKS, { echo: false })).toEqual([]);
  });

  it('nor after', () => {
    expect(leaksIn(moved, MARKS, { echo: false })).toEqual([]);
  });
});

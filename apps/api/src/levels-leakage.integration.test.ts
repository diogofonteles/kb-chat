import type { FastifyInstance } from 'fastify';
import type { ResearchEvent } from '@kb-chat/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, events, type Call } from '../test/ai-app-harness.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import {
  BODIES,
  NO_CONTENT,
  exchange,
  leaksIn,
  leavesOf,
  requestsOf,
  routesOf,
  type Candidates,
  type Exchange,
  type ProbeRequest,
} from '../test/leakage-probe.js';
import {
  HIDDEN_AUDIO,
  HIDDEN_SHA,
  MARK,
  OPEN_DOC_IDS,
  SENTINEL_DOCS,
  leakageWorld,
  type LeakageWorld,
} from '../test/leakage-world.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

/*
 * KBC-111 (ADR 0036 §12): every `/api/v1` route and every research event, called by Ana (CI)
 * with every candidate, carries no title, id, passage or author of a CDC item; the master,
 * with the same calls, gets every one of them (the probe reaches them).
 */

const call = (name: string, args: Record<string, unknown>): StubReply => ({
  toolCalls: [{ name, arguments: args }],
});

/** The research model reaches for every hidden item by name, id and word. */
const LOOKING: readonly StubReply[] = [
  call('search_collection', { query: 'lua', mode: 'all' }),
  call('search_collection', { query: 'zqxcorpo zqxaula zqxfala', mode: 'all' }),
  call('find_text', { phrase: 'zqxcorpo', output_mode: 'content' }),
  call('find_text', { phrase: 'lua', output_mode: 'files' }),
  call('list_sources', {}),
  call('list_subjects', {}),
  call('read_document', { document: 'raw/zqx-raiz.md' }),
  call('read_documents', {
    documents: ['aulas/raw/zqx-aula.md', 'raw/zqx-copia.md'],
  }),
  call('related_documents', { document: 'raw/ligado.md' }),
  call('read_document', { document: 'wiki/concepts/Zqxconceito.md' }),
  { text: 'Segundo o acervo, a lua aparece [1].' },
];

const PLAN: StubReply = {
  toolCalls: [
    {
      name: 'plan_sweep',
      arguments: { target: {}, phrases: [], extract: 'o que se diz da lua' },
    },
  ],
};

/** What the scripted model itself writes in its tool calls: its echo is not a leak. */
const SCRIPT_WORDS = [...LOOKING, PLAN].flatMap((reply) =>
  'toolCalls' in reply
    ? reply.toolCalls.flatMap((one) => leavesOf(one.arguments))
    : [],
);

const withScript = (request: ProbeRequest): ProbeRequest =>
  request.route.includes('/research')
    ? { ...request, inputs: [...request.inputs, ...SCRIPT_WORDS] }
    : request;

/** The stub: the looking script for a deep turn, a whole-collection plan for the exhaustive. */
const stubModel = () =>
  new StubLlmAdapter({
    script: LOOKING,
    batchReply: () => '',
  });

const candidatesOf = (one: LeakageWorld): Candidates => ({
  documents: [
    ...SENTINEL_DOCS.map((doc) => doc.id),
    // The sub-collection's text by its id in the top-level collection (ADR 0028).
    'aulas/raw/zqx-aula.md',
    ...OPEN_DOC_IDS,
  ],
  media: [
    ...new Set([
      ...(one.hidden ? [one.hidden.recording, one.hidden.track] : []),
      one.recording.id,
      ...one.tracks.map((track) => track.id),
    ]),
  ],
  conversations: one.conversation ? [one.conversation] : [],
  bookmarks: one.bookmark ? [one.bookmark] : [],
});

const BODIES_HERE: Readonly<Record<string, readonly object[]>> = {
  ...BODIES,
  'POST /api/v1/topics/:topic/media/check': [
    { sha256: HIDDEN_SHA, bytes: HIDDEN_AUDIO.length, durationMs: null },
  ],
};

let sentinel: LeakageWorld;
let llm: StubLlmAdapter;
let ana: Exchange[] = [];
let master: Exchange[] = [];
let readRoutes: string[] = [];
let sentinelCounts: Awaited<ReturnType<typeof sentinelCountsOf>>;

/** Reads first (GET and the declared POST bodies), as Ana and as the master; writes last. */
beforeAll(async () => {
  llm = stubModel();
  sentinel = await leakageWorld({ sentinels: true, llm });
  const candidates = candidatesOf(sentinel);
  const routes = routesOf(sentinel.world.started.app);
  readRoutes = routes.filter(
    (route) => route.startsWith('GET ') || BODIES_HERE[route] !== undefined,
  );
  const reads = readRoutes
    .flatMap((route) => requestsOf(route, candidates, BODIES_HERE))
    .map(withScript);
  ana = await exchange(sentinel.ana.call, reads, llm);
  master = await exchange(sentinel.world.owner, reads, llm);
  sentinelCounts = await sentinelCountsOf(sentinel.ana.call);
  const writes = routes
    .filter((route) => !readRoutes.includes(route))
    .flatMap((route) => requestsOf(route, candidates, BODIES_HERE));
  ana.push(...(await exchange(sentinel.ana.call, writes, llm)));
}, 120_000);

afterAll(async () => {
  await sentinel?.world.started.app.close();
});

const hiddenIds = () =>
  sentinel.hidden ? [sentinel.hidden.recording, sentinel.hidden.track] : [];

describe('Nothing leaks across levels (KBC-111, ADR 0036 §12)', () => {
  it('AC-1, BR-1: no route nor research event gives Ana a mark of a CDC item', () => {
    expect(ana.length).toBeGreaterThan(300);
    expect(leaksIn(ana, [MARK, ...hiddenIds()])).toEqual([]);
  });

  it('AC-1 (control): the master gets every mark through the same calls', () => {
    const text = master
      .map((one) => one.text)
      .join('\n')
      .toLowerCase();
    const marks = [
      'zqx-raiz',
      'zqx-aula',
      'zqxconceito',
      'zqx-copia',
      'zqxfaixa',
      'zqxfala',
      'zqxgravacao',
      'zqxgravfala',
      ...hiddenIds(),
    ];
    expect(marks.filter((mark) => !text.includes(mark))).toEqual([]);
  });

  it('BR-2: every read route answers someone with content, or says why not', () => {
    const answered = new Set(
      [...ana, ...master]
        .filter((one) => one.status < 300)
        .map((one) => one.route),
    );
    const empty = readRoutes.filter(
      (route) => !answered.has(route) && NO_CONTENT[route] === undefined,
    );
    expect(empty).toEqual([]);
  });
});

/** A route as a careless new feature would write it: every title, no view (AC-2). */
const ROGUE = '/api/v1/topics/:topic/leak-probe';
const rogueRoute = (app: FastifyInstance, catalog: CatalogRegistry) => {
  app.get<{ Params: { topic: string } }>(
    ROGUE,
    { config: { access: { topicParam: 'topic' } } },
    async (request) => ({
      titles: [
        ...(catalog.get(request.params.topic)?.entries.values() ?? []),
      ].map((entry) => entry.title),
    }),
  );
};

describe('A new route that skips the view is caught (KBC-111 AC-2, BR-2)', () => {
  afterEach(closeApp);

  it('AC-2: the probe finds the route by itself and fails naming it', async () => {
    const rogue = await leakageWorld({ sentinels: true, routes: rogueRoute });
    const app = rogue.world.started.app;
    const routes = routesOf(app).filter((route) => route.endsWith(ROGUE));

    const probed = await exchange(
      rogue.ana.call,
      routes.flatMap((route) => requestsOf(route, candidatesOf(rogue))),
    );

    expect(routes).toEqual([`GET ${ROGUE}`]);
    const leaks = leaksIn(probed, [MARK]);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.every((leak) => leak.startsWith(`GET ${ROGUE} (`))).toBe(true);
  });
});

/** UUIDs differ between two worlds; times, timings and the vault's folder too. */
const VOLATILE = new Set([
  'tookMs',
  'asOf',
  'createdAt',
  'updatedAt',
  'at',
  'version',
  'etag',
  // Accepted (ADR 0036 KBC-106 FR-2): the player and the transcript announce a hidden part of
  // a recording Ana hears, with its bounds ("Trecho restrito").
  'hidden',
  // Accepted with it: a speech hit's BM25 score is computed over the whole FTS5 table, so its
  // value moves with the size of the hidden transcripts; the order of what Ana sees does not.
  'score',
]);
/**
 * Accepted with the hidden part: a track's place among its recording's tracks ("faixa 3 de
 * 3"), which says no more than the announced part does (no title, level or text).
 */
const TRACK_PLACE = ['ordinal', 'total'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VAULT = /vault=[^&]+/g;

const keptKeys = (value: object) => {
  const place = 'ordinal' in value;
  return Object.entries(value).filter(
    ([key]) => !VOLATILE.has(key) && !(place && TRACK_PLACE.includes(key)),
  );
};

const normalized = (value: unknown): unknown => {
  if (typeof value === 'string')
    return value.replace(UUID, '<id>').replace(VAULT, 'vault=<tmp>');
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      keptKeys(value).map(([key, inner]) => [key, normalized(inner)]),
    );
  return value;
};

/** What Ana reads of counts: lists, facets, totals, copies, relations, library and search. */
const COUNTED: readonly (readonly [string, string, object?])[] = [
  ['GET', '/api/v1/topics'],
  ['GET', '/api/v1/topics/hermetismo/facets'],
  ['GET', '/api/v1/topics/hermetismo%2Faulas/facets'],
  ['GET', '/api/v1/topics/hermetismo/suggestions'],
  ['POST', '/api/v1/topics/hermetismo/searches', { q: 'lua' }],
  ['POST', '/api/v1/topics/hermetismo/searches', { q: 'tábua' }],
  ['POST', '/api/v1/topics/hermetismo/searches', { q: 'lua', mode: 'exact' }],
  ['GET', '/api/v1/topics/hermetismo/documents/raw%2Fligado.md'],
  ['GET', '/api/v1/topics/hermetismo/documents/raw%2Ftabua.md'],
  [
    'GET',
    '/api/v1/topics/hermetismo/documents/raw%2Fligado.md/relations/related',
  ],
  ['GET', '/api/v1/topics/hermetismo/media'],
  ['GET', '/api/v1/media/library'],
  ['GET', '/api/v1/media/library/search?q=lua'],
  ['GET', '/api/v1/media/library/home'],
  ['GET', '/api/v1/media/bookmarks'],
];

async function countsOf(who: Call): Promise<unknown[]> {
  const read: unknown[] = [];
  for (const [method, url, payload] of COUNTED) {
    const response = await who(method as 'GET', url, payload);
    read.push({
      url,
      status: response.statusCode,
      body: normalized(response.json()),
    });
  }
  return read;
}

/** The exhaustive turn's coverage and planned set, and the sources a deep turn cites. */
async function researchCountsOf(who: Call): Promise<unknown> {
  const turn = async (profile: string) =>
    events(
      (
        await who('POST', '/api/v1/topics/hermetismo/research', {
          question: 'Liste tudo o que o acervo diz sobre a lua',
          profile,
        })
      ).body,
    );
  const exhaustive = await turn('exhaustive');
  const deep = await turn('deep');
  const done = exhaustive.find((event) => event.type === 'done');
  const sweeps = exhaustive.flatMap((event) =>
    event.type === 'sweep' ? [event.sweep] : [],
  );
  return normalized({
    coverage: done?.type === 'done' ? done.coverage : null,
    sweeps,
    sources: deep.flatMap((event: ResearchEvent) =>
      event.type === 'sources' ? event.sources.map((one) => one.title) : [],
    ),
  });
}

describe('Side channels (KBC-111 AC-5)', () => {
  afterEach(closeApp);

  it('AC-5: Ana counts the same as in a collection where the hidden items do not exist', async () => {
    const { asIs, research, check } = sentinelCounts;
    const twin = await leakageWorld({ sentinels: false, llm: stubModel() });

    const without = await countsOf(twin.ana.call);
    const twinResearch = await researchCountsOf(twin.ana.call);

    expect(asIs).toEqual(without);
    expect(research).toEqual(twinResearch);
    // The one answer that differs, decided by KBC-105 FR-5: whoever holds the identical file
    // learns it is already here, and nothing else (no id, title, level or count).
    expect(check).toEqual({ verdict: 'duplicate-hidden' });
  });
});

/** Ana's counts in the sentinel world, read before the probe's writes run. */
async function sentinelCountsOf(who: Call) {
  const check = await who('POST', '/api/v1/topics/hermetismo/media/check', {
    sha256: HIDDEN_SHA,
    bytes: HIDDEN_AUDIO.length,
    durationMs: null,
  });
  return {
    asIs: await countsOf(who),
    research: await researchCountsOf(who),
    check: check.json(),
  };
}

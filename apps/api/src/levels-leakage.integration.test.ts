import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { ResearchEvent } from '@kb-chat/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fix } from '../test/correction-harness.js';
import {
  closeApp,
  events,
  type Call,
  type StartOptions,
} from '../test/ai-app-harness.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import {
  BODIES,
  HIDDEN_FINDING,
  NO_CONTENT,
  SCHEMA_ONLY,
  UNKNOWN_BOOKMARK,
  UNKNOWN_DOCUMENT,
  UNKNOWN_MEDIA,
  differFromUnknown,
  exchange,
  namingHidden,
  leaksIn,
  leavesOf,
  requestsOf,
  routesOf,
  type Candidates,
  type Exchange,
  type ProbeRequest,
  type Send,
} from '../test/leakage-probe.js';
import {
  HIDDEN_AUDIO,
  HIDDEN_SHA,
  MARK,
  OPEN_DOC_IDS,
  SECRET,
  SECRETS,
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

/** What the scripted model itself writes in its tool calls: its echo is not a leak. */
const SCRIPT_WORDS = LOOKING.flatMap((reply) =>
  'toolCalls' in reply
    ? reply.toolCalls.flatMap((one) => leavesOf(one.arguments))
    : [],
);

const withScript = (request: ProbeRequest): ProbeRequest =>
  request.route.includes('/research')
    ? { ...request, inputs: [...request.inputs, ...SCRIPT_WORDS] }
    : request;

/** The scripted model of a world: its script (completed once the world exists) and batches. */
interface Model {
  readonly llm: StubLlmAdapter;
  readonly script: StubReply[];
  /** Every sweep batch the model was given, as the app wrote it (sweep-planner). */
  readonly batches: string[];
}

/**
 * The stub follows the looking script on a deep turn; on an exhaustive one the app plans and
 * sweeps by itself (ADR 0021) and each batch answers with no finding.
 */
const stubModel = (): Model => {
  const script = [...LOOKING];
  const batches: string[] = [];
  const llm = new StubLlmAdapter({
    script,
    batchReply: (user) => {
      batches.push(user);
      return '';
    },
  });
  return { llm, script, batches };
};

/**
 * The world's open track documents read by id, and the links of the concept they are about:
 * the sources event and what the model is told carry their "faixa n de N" (QA BUG-2).
 */
function readTracks(model: Model, one: LeakageWorld): void {
  const open = one.tracks
    .filter((track) => track.title === 'Primeira' || track.title === 'Terceira')
    .map((track) => `raw/media/${one.recording.id}/${track.id}.md`);
  model.script.splice(
    model.script.length - 1,
    0,
    call('read_documents', { documents: open }),
    call('related_documents', { document: 'wiki/concepts/Ritmo.md' }),
  );
}

const HIDDEN_DOCUMENTS = [
  ...SENTINEL_DOCS.map((doc) => doc.id),
  // The sub-collection's text by its id in the top-level collection (ADR 0028).
  'aulas/raw/zqx-aula.md',
];

const candidatesOf = (one: LeakageWorld): Candidates => {
  const hiddenMedia = one.hidden
    ? [one.hidden.recording, one.hidden.track]
    : [];
  const hiddenBookmarks = one.bookmark ? [one.bookmark] : [];
  return {
    documents: [...HIDDEN_DOCUMENTS, ...OPEN_DOC_IDS, UNKNOWN_DOCUMENT],
    media: [
      ...new Set([
        ...hiddenMedia,
        one.recording.id,
        ...one.tracks.map((track) => track.id),
        UNKNOWN_MEDIA,
      ]),
    ],
    conversations: one.conversation ? [one.conversation] : [],
    bookmarks: [...hiddenBookmarks, UNKNOWN_BOOKMARK],
    unknownOf: new Map([
      ...hiddenMedia.map((id) => [id, UNKNOWN_MEDIA] as const),
      ...hiddenBookmarks.map((id) => [id, UNKNOWN_BOOKMARK] as const),
      ...HIDDEN_DOCUMENTS.map((id) => [id, UNKNOWN_DOCUMENT] as const),
    ]),
    bodies: [
      ...hiddenMedia.map((uuid, at) => ({
        uuid,
        document: HIDDEN_DOCUMENTS[at] ?? UNKNOWN_DOCUMENT,
      })),
      { uuid: UNKNOWN_MEDIA, document: UNKNOWN_DOCUMENT },
    ],
  };
};

const BODIES_HERE: Readonly<Record<string, readonly object[]>> = {
  ...BODIES,
  'POST /api/v1/topics/:topic/media/check': [
    { sha256: HIDDEN_SHA, bytes: HIDDEN_AUDIO.length, durationMs: null },
  ],
};

/** A person's requests; a write carries an If-Match, so version checks are reached too. */
const sender =
  (app: FastifyInstance, headers: Record<string, string>): Send =>
  (request) =>
    app.inject({
      method: request.method,
      url: request.url,
      headers: {
        ...headers,
        ...(request.method !== 'GET' && { 'if-match': '"1"' }),
      },
      ...(request.payload && { payload: request.payload }),
    });

let sentinel: LeakageWorld;
let model: Model;
let llm: StubLlmAdapter;
let ana: Exchange[] = [];
let master: Exchange[] = [];
let anaWrites: Exchange[] = [];
let firstReads: Exchange[] = [];
let afterCorrection: Exchange[] = [];

/** A read as compared across the correction: timings and times aside. */
const readKey = (one: Exchange) =>
  `${one.status} ${JSON.stringify(one.headers)} ${one.body
    .replace(/"tookMs":\d+/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<at>')}`;
let candidates: Candidates;
let readRoutes: string[] = [];
let sentinelCounts: Awaited<ReturnType<typeof sentinelCountsOf>>;

/** Reads first (GET and the declared POST bodies), as Ana and as the master; writes last. */
beforeAll(async () => {
  model = stubModel();
  llm = model.llm;
  sentinel = await leakageWorld({ sentinels: true, llm });
  readTracks(model, sentinel);
  candidates = candidatesOf(sentinel);
  const app = sentinel.world.started.app;
  const routes = routesOf(app);
  const isRead = (route: string) =>
    route.startsWith('GET ') || BODIES_HERE[route] !== undefined;
  readRoutes = routes.map((one) => one.route).filter(isRead);
  const reads = routes
    .filter((one) => isRead(one.route))
    .flatMap((one) => requestsOf(one, candidates, BODIES_HERE))
    .map(withScript);
  ana = await exchange(sender(app, sentinel.ana.headers), reads, llm);
  master = await exchange(sender(app, sentinel.world.ownerHeaders), reads, llm);
  sentinelCounts = await sentinelCountsOf(sentinel);
  // SUG-6: the master corrects a word inside the hidden part; Ana reads everything again.
  const gets = reads.filter((one) => one.method === 'GET');
  firstReads = ana.filter((one) => one.method === 'GET');
  const fixed = await fix(sentinel.world.owner, sentinel.recording.id, {
    from: 'velada',
    to: 'escondida',
  });
  expect(fixed.statusCode, fixed.body).toBe(201);
  afterCorrection = await exchange(
    sender(app, sentinel.ana.headers),
    gets,
    llm,
  );
  const writes = routes
    .filter((one) => !isRead(one.route))
    .flatMap((one) => requestsOf(one, candidates, BODIES_HERE));
  anaWrites = await exchange(sender(app, sentinel.ana.headers), writes, llm);
  ana.push(...anaWrites);
}, 120_000);

afterAll(async () => {
  await sentinel?.world.started.app.close();
});

const hiddenIds = () =>
  sentinel.hidden ? [sentinel.hidden.recording, sentinel.hidden.track] : [];

describe('Nothing leaks across levels (KBC-111, ADR 0036 §12)', () => {
  it('AC-1, BR-1: no route, header nor research event gives Ana a mark of a CDC item', () => {
    expect(leaksIn(ana, [MARK, ...hiddenIds()])).toEqual([]);
  });

  it('AC-1, BR-1: no response carries a second mark, with no echo taken out', () => {
    const sent = ana.flatMap((one) => one.inputs).join('\n');
    expect(sent.toLowerCase()).not.toContain(SECRET);
    // In audio and files the full second marks are looked for (`MIN_BINARY_MARK`).
    expect(leaksIn(ana, [SECRET, ...SECRETS], { echo: false })).toEqual([]);
  });

  it('AC-1 (control): the master receives every second mark, the audio bytes included', () => {
    const text = master
      .map((one) => one.text)
      .join('\n')
      .toLowerCase();
    expect(SECRETS.filter((mark) => !text.includes(mark))).toEqual([]);
  });

  it('ADR 0036 §8: a hidden finding Ana sends back in a sweep cursor reaches neither her stream nor her model', () => {
    const research = (people: readonly Exchange[]) =>
      people.filter((one) => one.route.endsWith('/research'));
    expect(leaksIn(research(ana), [HIDDEN_FINDING], { echo: false })).toEqual(
      [],
    );
    expect(
      leaksIn(research(master), [HIDDEN_FINDING], { echo: false }),
    ).not.toEqual([]);
  });

  it('PD-07: every request naming a hidden item answers Ana exactly like one naming an unknown item', () => {
    expect(namingHidden(ana, candidates.unknownOf)).toBeGreaterThan(300);
    expect(differFromUnknown(ana, candidates.unknownOf)).toEqual([]);
  });

  it("SUG-6: a correction inside the hidden part changes none of Ana's reads", () => {
    expect(afterCorrection.length).toBe(firstReads.length);
    // Her spend moves with her own research turns, which run between the two passes.
    const changed = afterCorrection.filter(
      (one, at) =>
        one.route !== 'GET /api/v1/spend/today' &&
        readKey(one) !== readKey(firstReads[at] ?? one),
    );
    expect(changed.map((one) => `${one.route} ${one.url}`)).toEqual([]);
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

  it('BR-2: every write reaches its handler (an answer other than a schema 400), or says why not', () => {
    // A 400 from the schema names the field it refused ("keyword"); one from the handler
    // (an unknown level, a path id that differs) means the request reached it.
    const bySchema = (one: Exchange) =>
      one.status === 400 && one.body.includes('"keyword"');
    const reached = new Set(
      anaWrites.filter((one) => !bySchema(one)).map((one) => one.route),
    );
    const routes = [...new Set(anaWrites.map((one) => one.route))];
    expect(
      routes.filter(
        (route) => !reached.has(route) && SCHEMA_ONLY[route] === undefined,
      ),
    ).toEqual([]);
  });
});

/** Routes as a careless new feature would write them: no view (AC-2). */
const ROGUE = '/api/v1/topics/:topic/leak-probe';
const ROGUE_BYTES = '/api/v1/media/:id/leak-download';

/** Every title of the collection, read from the catalog. */
const rogueTitles = (app: FastifyInstance, catalog: CatalogRegistry) =>
  app.get<{ Params: { topic: string } }>(
    ROGUE,
    { config: { access: { topicParam: 'topic' } } },
    async (request) => ({
      titles: [
        ...(catalog.get(request.params.topic)?.entries.values() ?? []),
      ].map((entry) => entry.title),
    }),
  );

/** The file of any media id, as a download (an offline copy) would send it. */
const rogueDownload = (app: FastifyInstance, state: string) =>
  app.get<{ Params: { id: string } }>(
    ROGUE_BYTES,
    { config: { access: { feature: 'media' } } },
    async (request, reply) => {
      const media = join(state, 'media');
      const db = new DatabaseSync(join(media, 'media.db'), { readOnly: true });
      const row = db
        .prepare('SELECT path FROM media_files WHERE media_id = ?')
        .get(request.params.id);
      db.close();
      if (!row) return reply.code(404).send();
      const bytes = await readFile(join(media, String(row['path'])));
      return reply.type('application/octet-stream').send(bytes);
    },
  );

const rogueRoutes: StartOptions['routes'] = (app, { catalog, state }) => {
  rogueTitles(app, catalog);
  rogueDownload(app, state);
};

describe('A new route that skips the view is caught (KBC-111 AC-2, BR-2)', () => {
  afterEach(closeApp);

  it('AC-2: the probe finds each route by itself and fails naming it, text or bytes', async () => {
    const rogue = await leakageWorld({ sentinels: true, routes: rogueRoutes });
    const app = rogue.world.started.app;
    const routes = routesOf(app).filter(
      (one) => one.route.endsWith(ROGUE) || one.route.endsWith(ROGUE_BYTES),
    );

    const probed = await exchange(
      sender(app, rogue.ana.headers),
      routes.flatMap((one) => requestsOf(one, candidatesOf(rogue))),
    );

    expect(routes.map((one) => one.route).sort()).toEqual(
      [`GET ${ROGUE}`, `GET ${ROGUE_BYTES}`].sort(),
    );
    const leaks = leaksIn(probed, [SECRET, ...SECRETS], { echo: false });
    for (const route of [ROGUE, ROGUE_BYTES])
      expect(leaks.some((leak) => leak.startsWith(`GET ${route} (`))).toBe(
        true,
      );
    expect(
      differFromUnknown(probed, candidatesOf(rogue).unknownOf),
    ).not.toEqual([]);
  });
});

/** UUIDs differ between two worlds; times and the vault's folder too. */
const VOLATILE = new Set(['tookMs', 'asOf', 'createdAt', 'updatedAt', 'at']);

/**
 * The known limit KBC-121: the header line the Mac writes into a track document's own text
 * ("Gravação: X · faixa n de N") counts every track; it reaches Ana only as that raw text
 * (a snippet, a read). Every number the API composes is compared.
 */
// The raw line is followed by the author or the length; the API's own ("· duração") is not
// masked, so its number is compared.
const RAW_TRACK_HEADER =
  /(Gravação: [^·\n]*) · faixa \d+ de \d+(?! · duração)/g;

/**
 * Accepted (ADR 0036, KBC-106 FR-2): where a hidden part of a recording Ana hears is ("Trecho
 * restrito"), only on a media item, the only object with both `hidden` and `parent`.
 */
const isMediaItem = (value: object) => 'hidden' in value && 'parent' in value;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VAULT = /vault=[^&]+/g;

const keptKeys = (value: object) =>
  Object.entries(value).filter(
    ([key]) => !VOLATILE.has(key) && !(key === 'hidden' && isMediaItem(value)),
  );

/**
 * A list whose items carry uuid ids (track documents, media) comes in an order that ties
 * break by those ids, which differ between the worlds: it is compared as a set of what it
 * holds. The order of results is still compared, through each document's rank score
 * (`rankScore`) and the [n] the tools give. Other lists keep their order.
 */
const sortedIfTied = (items: unknown[]): unknown[] =>
  items.some((item) => JSON.stringify(item).includes('<id>'))
    ? [...items].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      )
    : items;

/** A sweep cursor's covered ids are 4-byte hashes (of uuids here): their count is compared. */
const coveredCount = (covered: string): string =>
  `${Buffer.from(covered, 'base64').length / 4} ids`;

const normalized = (value: unknown): unknown => {
  if (typeof value === 'string')
    return value
      .replace(UUID, '<id>')
      .replace(VAULT, 'vault=<tmp>')
      .replace(RAW_TRACK_HEADER, '$1 · <KBC-121>');
  if (Array.isArray(value)) return sortedIfTied(value.map(normalized));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      keptKeys(value).map(([key, inner]) => [
        key,
        key === 'covered' && typeof inner === 'string'
          ? coveredCount(inner)
          : normalized(inner),
      ]),
    );
  return value;
};

/** What Ana reads of counts: lists, facets, totals, copies, relations, library and search. */
const COUNTED: readonly (readonly [string, string, object?])[] = [
  // Public, no session needed (review IMP-6).
  ['GET', '/health'],
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
  ['GET', '/api/v1/media/:recording/tracks'],
  ['GET', '/api/v1/media/:track1'],
  ['GET', '/api/v1/media/:track3'],
  // The concept of the track documents: its "Veja também" lists them (ADR 0035).
  ['GET', '/api/v1/topics/hermetismo/documents/wiki%2Fconcepts%2FRitmo.md'],
  [
    'GET',
    '/api/v1/topics/hermetismo/documents/wiki%2Fconcepts%2FRitmo.md/relations/relatedFrom',
  ],
];

/** The open recording's ids in a world, for the COUNTED urls that name them. */
const idsIn = (one: LeakageWorld) => ({
  ':recording': one.recording.id,
  ':track1': one.tracks.find((track) => track.title === 'Primeira')?.id ?? '',
  ':track3': one.tracks.find((track) => track.title === 'Terceira')?.id ?? '',
});

async function countsOf(one: LeakageWorld): Promise<unknown[]> {
  const who = one.ana.call;
  const read: unknown[] = [];
  for (const [method, template, payload] of COUNTED) {
    const url = Object.entries(idsIn(one)).reduce(
      (text, [name, id]) => text.replace(name, id),
      template,
    );
    const response = await who(method as 'GET', url, payload);
    read.push({
      url: template,
      status: response.statusCode,
      body: normalized(response.json()),
      // Content-Length is left out: it moves with `tookMs` and times, which are volatile.
      headers: normalized(
        Object.fromEntries(
          ['etag', 'location', 'content-disposition'].map((name) => [
            name,
            response.headers[name] ?? null,
          ]),
        ),
      ),
    });
  }
  return read;
}

/** The exhaustive turn's coverage and planned set, and the sources a deep turn cites. */
async function researchCountsOf(who: Call, of: Model): Promise<unknown> {
  const turn = async (profile: string) =>
    events(
      (
        await who('POST', '/api/v1/topics/hermetismo/research', {
          question: 'Liste tudo o que o acervo diz sobre a lua',
          profile,
        })
      ).body,
    );
  const batched = of.batches.length;
  const exhaustive = await turn('exhaustive');
  // The sweep's batches as the model got them, unit by unit ([Dn] follows the id order).
  const batches = of.batches
    .slice(batched)
    .join('\n')
    .split(/(?=\[D\d+\])/)
    .map((unit) => String(normalized(unit.replace(/^\[D\d+\]/, '[D]'))))
    .sort();
  const seen = of.llm.messagesSeen.length;
  const deep = await turn('deep');
  // What the model was told by each tool (list_sources, list_subjects, find_text…): its
  // counts too must be those of a collection without the hidden items (QA IMP-1).
  const tools = of.llm.messagesSeen
    .slice(seen)
    .at(-1)
    ?.filter((message) => message.role === 'tool')
    // [n] follows the order ties come in (uuid ids differ between the worlds).
    .map((message) =>
      message.content
        .replace(/\[\d+\]/g, '[n]')
        .split('\n')
        .map((line) => String(normalized(line)))
        .sort()
        .join('\n'),
    );
  const done = exhaustive.find((event) => event.type === 'done');
  const sweeps = exhaustive.flatMap((event) =>
    event.type === 'sweep' ? [event.sweep] : [],
  );
  return normalized({
    coverage: done?.type === 'done' ? done.coverage : null,
    sweeps,
    batches,
    // The cited sources whole: a track's "faixa n de N" travels in them (review R2-1).
    sources: deep.flatMap((event: ResearchEvent) =>
      event.type === 'sources'
        ? event.sources.map((source) => ({ ...source, n: 0 }))
        : [],
    ),
    tools,
  });
}

describe('Side channels (KBC-111 AC-5)', () => {
  afterEach(closeApp);

  it('AC-5: Ana counts the same as in a collection where the hidden items do not exist', async () => {
    const { asIs, research, check } = sentinelCounts;
    const twinModel = stubModel();
    const twin = await leakageWorld({ sentinels: false, llm: twinModel.llm });
    readTracks(twinModel, twin);

    const without = await countsOf(twin);
    const twinResearch = await researchCountsOf(twin.ana.call, twinModel);

    expect(asIs).toEqual(without);
    expect(research).toMatchObject({
      tools: expect.any(Array),
      batches: expect.arrayContaining([
        expect.stringContaining('faixa 1 de 2'),
      ]),
      sources: expect.arrayContaining([
        expect.objectContaining({
          media: expect.objectContaining({ ordinal: 2, total: 2 }),
        }),
      ]),
    });
    expect(research).toEqual(twinResearch);
    // The one answer that differs, decided by KBC-105 FR-5: whoever holds the identical file
    // learns it is already here, and nothing else (no id, title, level or count).
    expect(check).toEqual({ verdict: 'duplicate-hidden' });
  });
});

/** Ana's counts in the sentinel world, read before the probe's writes run. */
async function sentinelCountsOf(one: LeakageWorld) {
  const who = one.ana.call;
  const check = await who('POST', '/api/v1/topics/hermetismo/media/check', {
    sha256: HIDDEN_SHA,
    bytes: HIDDEN_AUDIO.length,
    durationMs: null,
  });
  return {
    asIs: await countsOf(one),
    research: await researchCountsOf(who, model),
    check: check.json(),
  };
}

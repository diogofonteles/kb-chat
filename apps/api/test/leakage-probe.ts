/**
 * The leakage probe (KBC-111 FR-1, BR-2): every route the app registered, called with every
 * candidate for its parameters and, for the writes, bodies drawn from the route's own schema
 * that name hidden (and unknown) items. The bytes that come back (headers, the SSE stream and
 * what the research model was told included) are searched for the marks of hidden items, and
 * every answer to a hidden id is compared with the answer to an id that does not exist.
 * Routes are read from `app.routeAccess`, so a new route is probed without anyone listing it;
 * only a route left out, or one that answers nobody, needs a declared reason here.
 */
import type {
  FastifyInstance,
  HTTPMethods,
  LightMyRequestResponse,
} from 'fastify';
import { SEE_ALSO_GROUPS } from '@kb-chat/contracts';
import type { StubLlmAdapter } from '../src/adapters/stub-llm-adapter.js';
import { bodyFor, type BodyIds } from './leakage-bodies.js';

/** Ids no route knows: what a hidden id must answer like (PD-07). */
export const UNKNOWN_MEDIA = '00000000-0000-4000-8000-000000000000';
export const UNKNOWN_BOOKMARK = '00000000-0000-4000-8000-0000000000b0';
export const UNKNOWN_DOCUMENT = 'raw/inexistente.md';

/** What a route's parameters and write bodies are filled with: hidden, open and unknown. */
export interface Candidates {
  readonly documents: readonly string[];
  readonly media: readonly string[];
  readonly conversations: readonly string[];
  readonly bookmarks: readonly string[];
  /** Each hidden value and the unknown one that must get the same answer. */
  readonly unknownOf: ReadonlyMap<string, string>;
  /** The id variants a write body is drawn with (hidden ones, and the unknown one). */
  readonly bodies: readonly BodyIds[];
}

/** A probed route: `GET /api/v1/media/:id`, with its body schema when it has one. */
export interface ProbedRoute {
  readonly route: string;
  readonly body?: unknown;
}

export interface ProbeRequest {
  readonly route: string;
  readonly method: HTTPMethods;
  readonly url: string;
  readonly payload?: object;
  /** What the request itself carries: an echo of it reveals nothing. */
  readonly inputs: readonly string[];
}

export interface Exchange extends ProbeRequest {
  readonly status: number;
  readonly body: string;
  /** The headers that can carry content or a count. */
  readonly headers: Readonly<Record<string, string>>;
  /** Body, those headers and what the research model was told during the request. */
  readonly text: string;
}

export type Send = (request: ProbeRequest) => Promise<LightMyRequestResponse>;

/** Collections: the top-level one and its sub-collection (ADR 0028). */
const TOPICS = ['hermetismo', 'hermetismo/aulas'];

/** Headers that could name or count something (review: ETag, length, location). */
const CONTENT_HEADERS = [
  'etag',
  'content-length',
  'location',
  'content-disposition',
  'content-range',
];

/**
 * Routes left out of the probe, each with why. Everything else is called: the reads as Ana
 * and as the master, then every other route as Ana.
 */
export const LEFT_OUT: Readonly<Record<string, string>> = {
  'POST /api/v1/auth/logout':
    'ends the session the probe is using; it returns nothing (204)',
};

/**
 * A finding of a hidden text in a cursor the page sends back: the server must drop it, so it
 * never reaches Ana's stream nor her model, though she sent it (it was hers while at CDC).
 */
export const HIDDEN_FINDING = 'zqxachado trecho velado da raiz';

/**
 * Bodies of the routes that read content through a POST (searches, research): called as Ana
 * and as the master. Every other write gets bodies drawn from its schema (`leakage-bodies`).
 */
export const BODIES: Readonly<Record<string, readonly object[]>> = {
  'POST /api/v1/topics/:topic/searches': [
    { q: 'lua' },
    { q: 'lua', mode: 'exact' },
    { q: 'lua', mode: 'semantic' },
    { q: 'zqxcorpo zqxaula zqxv zqxcopia zqxfala zqxgravfala' },
    { q: 'tábua' },
    { q: 'lua', filters: { concepts: ['Zqxconceito'] } },
    { q: 'lua', limit: 1, offset: 1 },
  ],
  'POST /api/v1/topics/:topic/research': [
    { question: 'o que dizem sobre a lua?', profile: 'deep' },
    {
      question: 'Liste tudo o que o acervo diz sobre a lua',
      profile: 'exhaustive',
    },
    {
      question: 'o que dizem da lua?',
      profile: 'deep',
      history: [{ question: 'e a raiz?', answer: 'Veja [1].' }],
    },
    // "Continuar varredura" with a cursor kept from when Ana was at CDC (ADR 0036 §8).
    {
      question: 'Liste tudo o que o acervo diz sobre a lua',
      profile: 'exhaustive',
      sweep: {
        plan: { target: {}, phrases: [], extract: 'o que diz da lua' },
        after: 'raw/zqx-raiz.md',
        totals: {
          documents: 6,
          scanned: 2,
          withHits: null,
          read: 2,
          batches: 1,
        },
        findings: [
          { id: 'raw/qs-1.md', text: 'a lua no primeiro grau' },
          { id: 'raw/zqx-raiz.md', text: HIDDEN_FINDING },
        ],
      },
    },
  ],
};

/**
 * Bodies for writes whose schema refines what the drawing cannot meet (a choice that must
 * differ, a real format), per id variant.
 */
export const WRITE_BODIES: Readonly<Record<string, (ids: BodyIds) => object>> =
  {
    'POST /api/v1/topics/:topic/document-levels': (ids) => ({
      ids: [{ topic: 'hermetismo', id: ids.document }],
      level: 'qs',
    }),
    'POST /api/v1/media/:id/subjects/decisions': (ids) => ({
      accept: [ids.uuid],
    }),
    'POST /api/v1/media/:id/voices/merge': () => ({
      version: 1,
      voice: 1,
      into: 2,
    }),
    'PUT /api/v1/media/preferences': () => ({ speed: 1 }),
    'POST /api/v1/topics/:topic/media': (ids) => ({
      title: 'Envio da Ana',
      author: null,
      fileName: 'envio.mp3',
      bytes: 30,
      level: 'ci',
      sha256: ids.uuid.replace(/-/g, '').padEnd(64, '0'),
    }),
    'POST /api/v1/auth/code': () => ({
      identifier: 'bia@example.com',
      channel: 'email',
    }),
    'POST /api/v1/auth/code/verify': () => ({
      identifier: 'bia@example.com',
      code: '123456',
    }),
    'POST /api/v1/access-requests/signup/verify': () => ({
      email: 'bia@example.com',
      code: '123456',
    }),
    'POST /api/v1/access-requests/signup': () => ({
      email: 'bia@example.com',
      firstName: 'Bia',
      lastName: 'Lima',
      phone: '+5511999998888',
    }),
  };

/**
 * Query strings for the GET routes that answer nothing useful without one ('' is always
 * tried as well).
 */
const QUERIES: Readonly<Record<string, readonly string[]>> = {
  '/api/v1/media/library/search': [
    'q=lua',
    'q=zqxfala',
    'q=zqxgravacao',
    'q=zqxfaixa',
    'q=Zqxgravfala',
    'q=lua&cursor=1',
  ],
  '/api/v1/media/library': ['sort=recent', 'state=started', 'cursor=1'],
  '/api/v1/media/:id/transcript/words': ['from=0&count=200', 'from=1&count=1'],
  '/api/v1/media/:id/transcript/occurrences': ['text=zqxfala', 'text=lua'],
  '/api/v1/media/:id/transcript/corrections': ['cursor=0'],
  '/api/v1/conversations': ['kind=research&topic=hermetismo'],
  '/api/v1/topics/:topic/documents/:id/relations/:group': ['offset=1'],
  '/api/v1/topics/:topic/levels/unassigned': ['cursor=1'],
  '/api/v1/levels/audit': ['topic=hermetismo'],
};

const MASTER_ONLY =
  'masters only (a member gets 403 from the guard) and a master sees every level';
const WORKER =
  'the media worker and the Mac by their token, never a person session (401 to Ana)';

/**
 * Read routes that answer nobody 2xx with these candidates, each with why. Every other read
 * must answer Ana or the master 2xx at least once, so that its probe is not empty.
 */
export const NO_CONTENT: Readonly<Record<string, string>> = {
  'GET /api/v1/research/turns/:turnId/events':
    'only while a turn of the person runs; the probed turns end inside their request, whose stream is probed',
  'GET /api/v1/openrouter/callback':
    'the OAuth return of a connection started by the same person; carries no content',
  'GET /api/v1/topics/:topic/speakers/:speakerId/named-voices': MASTER_ONLY,
  'GET /api/v1/voice-consents/:id/evidence': MASTER_ONLY,
  'GET /api/v1/media/:id/edit/proposals/:runId':
    'needs a paid AI run; behind the edit rule, which refuses Ana on this recording (403 EDIT_ABOVE_YOUR_LEVEL)',
  'GET /api/v1/media-worker/terms': WORKER,
  'GET /api/v1/media-worker/jobs/:id/audio': WORKER,
  'GET /api/v1/media-worker/jobs/:id/audio/:mediaId': WORKER,
  'GET /api/v1/media-worker/jobs/:id/voice-profiles': WORKER,
  'GET /mcp/turn':
    'a lent model by the turn token on loopback only; its tools are the research tools, probed through the research stream',
  'GET /mcp/turns/:token':
    'a lent model by the turn token on loopback only; its tools are the research tools, probed through the research stream',
};

/**
 * Writes whose every drawn body the schema refuses (a refinement the drawing cannot meet),
 * each with why its handler is safe without the probe reaching it.
 */
export const SCHEMA_ONLY: Readonly<Record<string, string>> = {};

const paramValues = (
  route: string,
  name: string,
  candidates: Candidates,
): readonly string[] => {
  const byName: Record<string, readonly string[]> = {
    topic: TOPICS,
    group: SEE_ALSO_GROUPS,
    name: ['Zqxconceito', 'Astrologia'],
    level: ['cdc'],
    bookmarkId: candidates.bookmarks,
    voice: ['1'],
    step: ['transcribe'],
  };
  if (name !== 'id') return byName[name] ?? [UNKNOWN_MEDIA];
  if (route.includes('/documents/:id')) return candidates.documents;
  if (route.includes('/media/:id')) return candidates.media;
  if (route.includes('/conversations/:id')) return candidates.conversations;
  return [UNKNOWN_MEDIA];
};

/** Every way to fill a route's parameters: the cross product of their candidates. */
function urlsOf(
  route: string,
  candidates: Candidates,
): { url: string; inputs: string[] }[] {
  const names = [...route.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? '');
  let filled = [{ url: route, inputs: [] as string[] }];
  for (const name of names)
    filled = filled.flatMap((one) =>
      paramValues(route, name, candidates).map((value) => ({
        url: one.url.replace(`:${name}`, encodeURIComponent(value)),
        inputs: [...one.inputs, value],
      })),
    );
  return filled;
}

/** The string leaves of a body: what the client itself sent. */
export const leavesOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leavesOf);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(leavesOf);
  return [];
};

const methodsOf = (method: HTTPMethods | HTTPMethods[]): HTTPMethods[] =>
  (Array.isArray(method) ? method : [method]).filter((one) => one !== 'HEAD');

/** Every probed route of the app, `/health` and `/mcp` included; HEAD runs GET's handler. */
export function routesOf(app: FastifyInstance): ProbedRoute[] {
  return app.routeAccess
    .flatMap((entry) =>
      methodsOf(entry.method).map((method) => ({
        route: `${method} ${entry.url}`,
        ...(entry.body !== undefined && { body: entry.body }),
      })),
    )
    .filter((one) => LEFT_OUT[one.route] === undefined);
}

const splitRoute = (route: string) => {
  const [method = 'GET', url = ''] = route.split(' ');
  return { method: method as HTTPMethods, url };
};

/** The bodies of a write: declared ones, else drawn from its schema per id variant. */
const payloadsOf = (
  probed: ProbedRoute,
  candidates: Candidates,
  bodies: Readonly<Record<string, readonly object[]>>,
): readonly object[] => {
  const declared = bodies[probed.route];
  if (declared) return declared;
  const written = WRITE_BODIES[probed.route];
  if (written) return candidates.bodies.map(written);
  if (probed.body === undefined) return [{}];
  return candidates.bodies.map((ids) => bodyFor(probed.body, ids));
};

/** The same request twice (a body with no id drawn per variant) is sent once. */
const once = (requests: readonly ProbeRequest[]): ProbeRequest[] => [
  ...new Map(
    requests.map((one) => [
      `${one.method} ${one.url} ${JSON.stringify(one.payload ?? null)}`,
      one,
    ]),
  ).values(),
];

/** The requests of one route: every URL, with each query (GET) or body. */
export function requestsOf(
  probed: ProbedRoute,
  candidates: Candidates,
  bodies: Readonly<Record<string, readonly object[]>> = BODIES,
): ProbeRequest[] {
  const { route } = probed;
  const { method, url } = splitRoute(route);
  const urls = urlsOf(url, candidates);
  if (method === 'GET')
    return urls.flatMap((one) =>
      ['', ...(QUERIES[url] ?? [])].map((query) => ({
        route,
        method,
        url: query ? `${one.url}?${query}` : one.url,
        inputs: [...one.inputs, ...new URLSearchParams(query).values()],
      })),
    );
  const payloads = payloadsOf(probed, candidates, bodies);
  return once(
    urls.flatMap((one) =>
      payloads.map((payload) => ({
        route,
        method,
        url: one.url,
        payload,
        inputs: [...one.inputs, ...leavesOf(payload)],
      })),
    ),
  );
}

const headersOf = (response: LightMyRequestResponse) =>
  Object.fromEntries(
    CONTENT_HEADERS.flatMap((name) => {
      const value = response.headers[name];
      return value === undefined ? [] : [[name, String(value)]];
    }),
  );

/** Calls each request, keeping body, headers and what the research model was told. */
export async function exchange(
  send: Send,
  requests: readonly ProbeRequest[],
  llm?: StubLlmAdapter,
): Promise<Exchange[]> {
  const done: Exchange[] = [];
  for (const request of requests) {
    const seen = llm?.messagesSeen.length ?? 0;
    const response = await send(request);
    const told = (llm?.messagesSeen.slice(seen) ?? [])
      .flat()
      .map((message) => message.content)
      .join('\n');
    const headers = headersOf(response);
    done.push({
      ...request,
      status: response.statusCode,
      body: response.body,
      headers,
      text: `${response.body}\n${JSON.stringify(headers)}\n${told}`,
    });
  }
  return done;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `q` and friends read as the letters they are, so an escaped mark is found too. */
const unescaped = (text: string) =>
  text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** The text without what the request sent (raw, URL-encoded or JSON-escaped). */
function withoutEcho(one: Exchange): string {
  let text = one.text;
  for (const input of one.inputs.filter((value) => value.length >= 3))
    for (const form of new Set([
      input,
      encodeURIComponent(input),
      JSON.stringify(input).slice(1, -1),
    ]))
      text = text.replace(new RegExp(escapeRegExp(form), 'gi'), '');
  return text;
}

/**
 * Each mark found in an exchange, with the bytes around it. With `echo: false` nothing is
 * taken out first: for marks no request ever sends (the second marks).
 */
export function leaksIn(
  exchanges: readonly Exchange[],
  marks: readonly string[],
  { echo = true }: { readonly echo?: boolean } = {},
): string[] {
  return exchanges.flatMap((one) => {
    const text = unescaped(echo ? withoutEcho(one) : one.text).toLowerCase();
    return marks.flatMap((mark) => {
      const at = text.indexOf(mark.toLowerCase());
      return at < 0
        ? []
        : [
            `${one.route} (${one.method} ${one.url} → ${one.status}): …${text.slice(Math.max(0, at - 40), at + 40)}…`,
          ];
    });
  });
}

/** The request with every hidden value in place of the unknown one it must answer like. */
function asUnknown(
  one: ProbeRequest,
  unknownOf: ReadonlyMap<string, string>,
): string {
  let key = `${one.method} ${one.url} ${JSON.stringify(one.payload ?? null)}`;
  for (const [hidden, unknown] of unknownOf)
    for (const [from, to] of [
      [encodeURIComponent(hidden), encodeURIComponent(unknown)],
      [hidden, unknown],
    ] as const)
      key = key.split(from).join(to);
  return key;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** An answer as compared across ids: what was asked for and the request's own ids aside. */
function comparable(
  one: Exchange,
  unknownOf: ReadonlyMap<string, string>,
): string {
  let text = one.body;
  for (const value of [...unknownOf.keys(), ...unknownOf.values()])
    text = text.split(value).join('<asked>');
  return `${one.status} ${text.replace(UUID, '<id>').replace(ISO, '<at>')}`;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/** A per-person rate limit answers by how many requests came before, not by the item. */
const RATE_LIMITED = 429;

/**
 * PD-07: every request that names a hidden item answers Ana exactly like the same request
 * naming an unknown one (status and body), so nothing confirms the hidden item exists.
 */
export function differFromUnknown(
  exchanges: readonly Exchange[],
  unknownOf: ReadonlyMap<string, string>,
): string[] {
  const byKey = new Map(
    exchanges.map((one) => [
      `${one.method} ${one.url} ${JSON.stringify(one.payload ?? null)}`,
      one,
    ]),
  );
  return exchanges.flatMap((one) => {
    const key = asUnknown(one, unknownOf);
    const twin = byKey.get(key);
    if (!twin || twin === one) return [];
    if (one.status === RATE_LIMITED || twin.status === RATE_LIMITED) return [];
    const mine = comparable(one, unknownOf);
    const theirs = comparable(twin, unknownOf);
    return mine === theirs
      ? []
      : [
          `${one.route} (${one.url}): ${mine.slice(0, 160)} ≠ ${theirs.slice(0, 160)}`,
        ];
  });
}

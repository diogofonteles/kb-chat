/**
 * The leakage probe (KBC-111 FR-1, BR-2): every `/api/v1` route the app registered, called
 * with every candidate for its parameters, and the bytes that come back (the SSE stream and
 * what the research model was told included) searched for the marks of hidden items. Routes
 * are read from `app.routeAccess`, so a new route is probed without anyone listing it; only
 * a route left out needs a declared reason here.
 */
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { SEE_ALSO_GROUPS } from '@kb-chat/contracts';
import type { StubLlmAdapter } from '../src/adapters/stub-llm-adapter.js';
import type { Call } from './ai-app-harness.js';

/** What a route's parameters are filled with: the hidden items first, then open ones. */
export interface Candidates {
  readonly documents: readonly string[];
  readonly media: readonly string[];
  readonly conversations: readonly string[];
  readonly bookmarks: readonly string[];
}

export interface ProbeRequest {
  /** `GET /api/v1/media/:id`: the route as registered. */
  readonly route: string;
  readonly method: HTTPMethods;
  readonly url: string;
  readonly payload?: object;
  /** What the request itself carries: an echo of it reveals nothing. */
  readonly inputs: readonly string[];
}

export interface Exchange extends ProbeRequest {
  readonly status: number;
  /** The body, with what the research model was told this request appended. */
  readonly text: string;
}

/** Ids no route knows: what fills a parameter with no candidates of its own. */
const NIL = '00000000-0000-4000-8000-000000000000';

/** Collections: the top-level one and its sub-collection (ADR 0028). */
const TOPICS = ['hermetismo', 'hermetismo/aulas'];

/**
 * Routes left out of the probe, each with why. Everything else is called, as Ana with
 * every candidate (writes last, with an empty body unless `BODIES` gives one).
 */
export const LEFT_OUT: Readonly<Record<string, string>> = {
  'POST /api/v1/auth/logout':
    'ends the session the probe is using; it returns nothing (204)',
};

/**
 * Bodies of the routes that read content through a POST (searches, research, the upload
 * check): called as Ana and as the master. Any other write is called as Ana with `{}`.
 */
export const BODIES: Readonly<Record<string, readonly object[]>> = {
  'POST /api/v1/topics/:topic/searches': [
    { q: 'lua' },
    { q: 'lua', mode: 'exact' },
    { q: 'lua', mode: 'semantic' },
    { q: 'zqxcorpo zqxaula zqxv zqxcopia zqxfala zqxgravfala' },
    { q: 'tábua' },
    { q: 'lua', filters: { concepts: ['Zqxconceito'] } },
  ],
  'POST /api/v1/topics/:topic/research': [
    { question: 'o que dizem sobre a lua?', profile: 'deep' },
    {
      question: 'Liste tudo o que o acervo diz sobre a lua',
      profile: 'exhaustive',
    },
  ],
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
  ],
  '/api/v1/media/:id/transcript/words': ['from=0&count=200'],
  '/api/v1/media/:id/transcript/occurrences': ['text=zqxfala', 'text=lua'],
  '/api/v1/conversations': ['kind=research&topic=hermetismo'],
  '/api/v1/media/library': ['sort=recent', 'state=started'],
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
};

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
  };
  if (name !== 'id') return byName[name] ?? [NIL];
  if (route.includes('/documents/:id')) return candidates.documents;
  if (route.startsWith('/api/v1/media/:id')) return candidates.media;
  if (route.startsWith('/api/v1/conversations/:id'))
    return candidates.conversations;
  return [NIL];
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

/** Every probed (method, route) of the app: `/api/v1`, HEAD aside (it runs GET's handler). */
export function routesOf(app: FastifyInstance): string[] {
  return app.routeAccess
    .filter((entry) => entry.url.startsWith('/api/v1/'))
    .flatMap((entry) => methodsOf(entry.method).map((m) => `${m} ${entry.url}`))
    .filter((route) => LEFT_OUT[route] === undefined);
}

const splitRoute = (route: string) => {
  const [method = 'GET', url = ''] = route.split(' ');
  return { method: method as HTTPMethods, url };
};

/** The requests of one route: every URL, with each query (GET) or declared body. */
export function requestsOf(
  route: string,
  candidates: Candidates,
  bodies: Readonly<Record<string, readonly object[]>> = BODIES,
): ProbeRequest[] {
  const { method, url } = splitRoute(route);
  const urls = urlsOf(url, candidates);
  if (method === 'GET')
    return urls.flatMap((one) =>
      ['', ...(QUERIES[url] ?? [])].map((query) => ({
        route,
        method,
        url: query ? `${one.url}?${query}` : one.url,
        inputs: [...one.inputs, ...[...new URLSearchParams(query).values()]],
      })),
    );
  const payloads = bodies[route] ?? [{}];
  return urls.flatMap((one) =>
    payloads.map((payload) => ({
      route,
      method,
      url: one.url,
      payload,
      inputs: [...one.inputs, ...leavesOf(payload)],
    })),
  );
}

/** Calls each request, keeping the body and what the research model was told meanwhile. */
export async function exchange(
  call: Call,
  requests: readonly ProbeRequest[],
  llm?: StubLlmAdapter,
): Promise<Exchange[]> {
  const done: Exchange[] = [];
  for (const request of requests) {
    const seen = llm?.messagesSeen.length ?? 0;
    const response = await call(request.method, request.url, request.payload);
    const told = (llm?.messagesSeen.slice(seen) ?? [])
      .flat()
      .map((message) => message.content)
      .join('\n');
    done.push({
      ...request,
      status: response.statusCode,
      text: `${response.body}\n${told}`,
    });
  }
  return done;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/** Each mark found in an exchange, with the bytes around it: `GET /url → …zqxraiz…`. */
export function leaksIn(
  exchanges: readonly Exchange[],
  marks: readonly string[],
): string[] {
  return exchanges.flatMap((one) => {
    const text = withoutEcho(one).toLowerCase();
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

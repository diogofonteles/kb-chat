import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebSearchResponse } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, closeApp, type Call } from '../test/ai-app-harness.js';
import {
  doc,
  memberOf,
  placeDocuments,
  createScale,
  setPersonLevel,
  startLevels,
  type LevelsWorld,
} from '../test/levels-world.js';
import { member, startMedia, type Media } from '../test/media-harness.js';

afterEach(closeApp);

// KBC-185 over HTTP: who may send documents searches the web for them; masters connect the
// house's Firecrawl key, which is never sent back nor logged.

const SETTINGS = '/api/v1/web-search/settings';
const AVAILABLE = '/api/v1/web-search/available';
const SEARCH = '/api/v1/topics/hermetismo/web-search';
const KEY = 'fc-live-secret-key-123-valid';
const QUERY = 'a palavra perdida do oriente';
const SLUG = 'a-palavra-perdida-do-oriente';
const PAGES = { query: QUERY, kinds: ['page'] };
const SENDS = ['search', 'media', 'media-upload'];

const connect = async (owner: Call, key = KEY) => {
  const saved = await owner('PUT', SETTINGS, { key });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved;
};

const ana = (media: Media, features = SENDS) =>
  member(media, {
    email: 'ana@example.com',
    topics: ['hermetismo'],
    features,
  });

const errorOf = (answer: { json: () => { error: { code: string } } }) =>
  answer.json().error.code;

describe('Who searches the web (KBC-185, KBC-009 R4)', () => {
  it('is who may send documents: the candidates, the credits and nothing added', async () => {
    const media = await startMedia();
    await connect(media.owner);
    const { call } = await ana(media);
    const found = await call('POST', SEARCH, {
      query: ` ${QUERY} `,
      kinds: ['page', 'video'],
    });
    expect(found.statusCode, found.body).toBe(200);
    const body = found.json<WebSearchResponse>();
    expect(body).toMatchObject({
      failedKinds: [],
      creditsUsed: 4,
      creditsRemaining: 996,
      low: false,
    });
    expect(body.results).toHaveLength(7);
    expect(body.results[0]).toEqual({
      kind: 'page',
      url: `https://www.exemplo.org/${SLUG}/1`,
      title: `${QUERY}: página 1`,
      snippet: `O que a página 1 diz sobre ${QUERY}.`,
      site: 'exemplo.org',
      already: null,
    });
    const uploads = await call('GET', '/api/v1/document-uploads');
    expect(uploads.json()).toEqual({ items: [] });
  });

  it('is refused without the permission, spending nothing', async () => {
    const media = await startMedia();
    await connect(media.owner);
    const { call } = await ana(media, ['search', 'media']);
    const found = await call('POST', SEARCH, PAGES);
    expect(found.statusCode).toBe(403);
    expect((await call('GET', AVAILABLE)).statusCode).toBe(403);
    expect(media.started.firecrawl.searches).toEqual([]);
  });

  it('is a 404 in a collection the person does not see, or that does not exist', async () => {
    const media = await startMedia();
    await connect(media.owner);
    const { call } = await ana(media);
    for (const [who, topic] of [
      [call, 'alquimia'],
      [call, 'nao-existe'],
      [media.owner, 'nao-existe'],
    ] as const) {
      const found = await who(
        'POST',
        `/api/v1/topics/${topic}/web-search`,
        PAGES,
      );
      expect(found.statusCode, found.body).toBe(404);
      expect(errorOf(found)).toBe('TOPIC_NOT_FOUND');
    }
    expect(media.started.firecrawl.searches).toEqual([]);
  });

  it('needs a session', async () => {
    const media = await startMedia();
    for (const [method, url] of [
      ['POST', SEARCH],
      ['GET', AVAILABLE],
      ['GET', SETTINGS],
      ['PUT', SETTINGS],
      ['DELETE', SETTINGS],
    ] as const) {
      const request = { method, url, headers: LOCAL };
      const answer = await media.started.app.inject(request);
      expect(answer.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a query that is too short, and an unknown kind', async () => {
    const media = await startMedia();
    await connect(media.owner);
    for (const body of [
      { query: 'ab', kinds: ['page'] },
      { query: QUERY, kinds: [] },
      { query: QUERY, kinds: ['audio'] },
      { query: QUERY, kinds: ['page'], limit: 31 },
    ])
      expect((await media.owner('POST', SEARCH, body)).statusCode).toBe(400);
    expect(media.started.firecrawl.searches).toEqual([]);
  });

  it('is limited per person, not per address', async () => {
    const media = await startMedia({ env: { WEB_SEARCH_RATE_LIMIT: '2' } });
    await connect(media.owner);
    const { call } = await ana(media);
    const codes = async (who: Call) =>
      (await who('POST', SEARCH, PAGES)).statusCode;
    expect([await codes(call), await codes(call)]).toEqual([200, 200]);
    const third = await call('POST', SEARCH, PAGES);
    expect(third.statusCode).toBe(429);
    expect(errorOf(third)).toBe('RATE_LIMITED');
    expect(await codes(media.owner)).toBe(200);
    expect(media.started.firecrawl.searches).toHaveLength(3);
  });
});

describe('What a search answers when it cannot search', () => {
  it('says it is not connected', async () => {
    const media = await startMedia();
    const { call } = await ana(media);
    expect((await call('GET', AVAILABLE)).json()).toEqual({
      connected: false,
      low: false,
    });
    const found = await call('POST', SEARCH, PAGES);
    expect(found.statusCode).toBe(409);
    expect(errorOf(found)).toBe('WEB_SEARCH_NOT_CONNECTED');
  });

  it('says the credits ended, that it must wait, and that Firecrawl is down', async () => {
    const media = await startMedia();
    await connect(media.owner, 'fc-empty-account-valid');
    const spent = await media.owner('POST', SEARCH, PAGES);
    expect(spent.statusCode).toBe(402);
    expect(errorOf(spent)).toBe('WEB_SEARCH_NO_CREDITS');

    await connect(media.owner);
    const { firecrawl } = media.started;
    firecrawl.rateLimitNext(1);
    const limited = await media.owner('POST', SEARCH, PAGES);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 7 },
    });

    firecrawl.goDown();
    const down = await media.owner('POST', SEARCH, PAGES);
    expect(down.statusCode).toBe(503);
    expect(errorOf(down)).toBe('WEB_SEARCH_UNAVAILABLE');
  });

  it('gives what the pages found when the videos failed, and names the kind', async () => {
    const media = await startMedia();
    await connect(media.owner);
    media.started.firecrawl.breakSearchesOf('video');
    const found = await media.owner('POST', SEARCH, {
      query: QUERY,
      kinds: ['page', 'video'],
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      failedKinds: ['video'],
      creditsUsed: 2,
    });
  });
});

describe('What the collection already has', () => {
  const link = (n: number) => `https://www.exemplo.org/${SLUG}/${n}`;
  const at = (n: number) => `source_path: "${link(n)}"`;

  /** Page 1 in the collection, 2 in its sub-collection, 3 above Ana's level. */
  async function world(): Promise<LevelsWorld> {
    const started = await startLevels(
      [
        doc('hermetismo/raw/um.md', 'Um', { body: 'Um.', extra: at(1) }),
        doc('hermetismo/aulas/raw/dois.md', 'Dois', {
          body: 'Dois.',
          extra: at(2),
        }),
        doc('hermetismo/raw/tres.md', 'Três Velado', {
          body: 'Três.',
          extra: at(3),
        }),
      ],
      { media: true },
    );
    await createScale(started, ['QS', 'CDC']);
    await placeDocuments(started, { 'hermetismo:raw/tres.md': 'cdc' });
    await connect(started.owner);
    return started;
  }

  const searched = async (call: Call) => {
    const found = await call('POST', SEARCH, PAGES);
    expect(found.statusCode, found.body).toBe(200);
    const { results } = found.json<WebSearchResponse>();
    return { body: found.body, already: results.map((one) => one.already) };
  };

  it('is named by its id in the collection, a sub-collection’s too, unless above the person’s level', async () => {
    const started = await world();
    const { call, id } = await memberOf(started, 'ana@example.com', {
      features: SENDS,
    });
    await setPersonLevel(started, id, { hermetismo: 'qs' });
    const seen = await searched(call);
    expect(seen.already).toEqual([
      { document: { id: 'raw/um.md', title: 'Um' } },
      { document: { id: 'aulas/raw/dois.md', title: 'Dois' } },
      { document: null },
      null,
    ]);
    expect(seen.body).not.toContain('Velado');
    expect(seen.body).not.toContain('tres.md');
    // The link of the sub-collection's document opens from the collection.
    const opened = await call(
      'GET',
      `/api/v1/topics/hermetismo/documents/${encodeURIComponent('aulas/raw/dois.md')}`,
    );
    expect(opened.statusCode, opened.body).toBe(200);
    expect((await searched(started.owner)).already[2]).toEqual({
      document: { id: 'raw/tres.md', title: 'Três Velado' },
    });
  });

  it('counts a link on its way, sent by anyone, without naming it', async () => {
    const media = await startMedia();
    await connect(media.owner);
    const { call } = await ana(media);
    const sent = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/documents',
      {
        kind: 'url',
        url: link(4),
      },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await searched(call)).already).toEqual([
      null,
      null,
      null,
      { document: null },
    ]);
  });
});

describe('The house’s Firecrawl key', () => {
  it('is tested, kept sealed, and never sent back or logged', async () => {
    const media = await startMedia();
    const saved = await connect(media.owner);
    expect(saved.json()).toMatchObject({
      connected: true,
      keyHint: 'alid',
      credits: {
        remaining: 1_000,
        plan: 1_000,
        periodEnd: '2026-12-15T12:00:00.000Z',
      },
      low: false,
      problem: null,
    });
    const seen = await media.owner('GET', SETTINGS);
    const { call } = await ana(media);
    const found = await call('POST', SEARCH, PAGES);
    const available = await call('GET', AVAILABLE);
    expect(available.json()).toEqual({ connected: true, low: false });
    for (const { body } of [saved, seen, found, available])
      expect(body).not.toContain(KEY);
    const file = await readFile(
      join(media.started.state, 'web-search.json'),
      'utf8',
    );
    expect(file).toContain('enc:v1:');
    expect(file).not.toContain(KEY);
    const logs = media.started.logs.join('');
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(QUERY);
  });

  it('is not saved, echoed or logged when Firecrawl refuses it or it is not a key', async () => {
    const media = await startMedia();
    const wrong = 'fc-wrong-secret-key-456';
    const refused = await media.owner('PUT', SETTINGS, { key: wrong });
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused)).toBe('WEB_SEARCH_KEY_REJECTED');
    const malformed = 'fc-segredo com espaço';
    const invalid = await media.owner('PUT', SETTINGS, { key: malformed });
    expect(invalid.statusCode).toBe(400);
    media.started.firecrawl.goDown();
    const down = await media.owner('PUT', SETTINGS, { key: KEY });
    expect(down.statusCode).toBe(503);
    expect(errorOf(down)).toBe('WEB_SEARCH_UNAVAILABLE');

    expect((await media.owner('GET', SETTINGS)).json()).toMatchObject({
      connected: false,
      keyHint: null,
    });
    const told = [refused.body, invalid.body, down.body].join();
    const logs = media.started.logs.join('');
    for (const key of [wrong, malformed, KEY]) {
      expect(told).not.toContain(key);
      expect(logs).not.toContain(key);
    }
  });

  it('is opened again after a restart, and removed', async () => {
    const media = await startMedia();
    await connect(media.owner);
    const { state } = media.started;
    await closeApp();
    const again = await startMedia({ state });
    expect((await again.owner('GET', SETTINGS)).json()).toMatchObject({
      connected: true,
      credits: { remaining: 1_000 },
    });
    const removed = await again.owner('DELETE', SETTINGS);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ connected: false, credits: null });
  });

  it('is for masters: a member sees neither the key nor the balance', async () => {
    const media = await startMedia();
    await connect(media.owner);
    const { call } = await ana(media);
    const answers = [
      await call('GET', SETTINGS),
      await call('PUT', SETTINGS, { key: 'fc-other-key-valid' }),
      await call('DELETE', SETTINGS),
    ];
    expect(answers.map((one) => one.statusCode)).toEqual([403, 403, 403]);
    expect((await call('GET', AVAILABLE)).body).not.toContain('1000');
    expect((await media.owner('GET', SETTINGS)).json().connected).toBe(true);
  });

  it('is never changed by a master acting as someone', async () => {
    const media = await startMedia();
    await connect(media.owner);
    await ana(media);
    const people = (await media.owner('GET', '/api/v1/people')).json().items;
    const { id } = people.find(
      (one: { email: string }) => one.email === 'ana@example.com',
    );
    const acting = await media.owner('POST', `/api/v1/people/${id}/act-as`, {
      reason: 'Conferir a pesquisa na web',
    });
    expect(acting.statusCode, acting.body).toBe(200);
    for (const answer of [
      await media.owner('PUT', SETTINGS, { key: 'fc-other-key-valid' }),
      await media.owner('DELETE', SETTINGS),
    ]) {
      expect(answer.statusCode).toBe(403);
      expect(errorOf(answer)).toBe('NOT_WHILE_ACTING');
    }
    expect((await media.owner('DELETE', '/api/v1/act-as')).statusCode).toBe(
      204,
    );
    expect((await media.owner('GET', SETTINGS)).json()).toMatchObject({
      connected: true,
      keyHint: 'alid',
    });
    expect(media.started.firecrawl.accountChecks).toEqual([KEY]);
  });
});

import { randomBytes } from 'node:crypto';
import type { WebSearchRequest } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { FirecrawlClient } from '../../adapters/firecrawl-client.js';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { SecretBox } from '../../adapters/secret-box.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { FakeFirecrawl } from '../../testing/fake-firecrawl.js';
import type {
  WebSearchAnswer,
  WebSearchPort,
  WebSearchQuery,
} from '../../ports/web-search.js';
import { SETTINGS_TTL_MS, SeenLinks, WebSearchService } from './index.js';

const KEY = 'fc-house-key-valid';
const REQUEST: WebSearchRequest = {
  query: 'hermetismo',
  sources: 9,
  kinds: ['text', 'audio', 'video'],
  authors: [],
  again: false,
};
const NEW = {
  principal: 'ana',
  topic: 'hermetismo',
  alreadyOf: () => null,
};

function build(
  options: {
    store?: DocumentStorePort;
    sealer?: SecretBox;
    seen?: DocumentStorePort;
  } = {},
) {
  const firecrawl = new FakeFirecrawl();
  const store = options.store ?? new MemoryDocumentStore();
  const sealer = options.sealer ?? new SecretBox(randomBytes(32));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let time = Date.parse('2026-11-25T12:00:00.000Z');
  const service = new WebSearchService({
    store,
    sealer,
    web: new FirecrawlClient({ fetch: firecrawl.fetch }),
    seen: new SeenLinks(options.seen ?? new MemoryDocumentStore()),
    log,
    now: () => new Date(time),
  });
  const later = (ms: number) => {
    time += ms;
  };
  return { service, firecrawl, store, sealer, log, later };
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (err: unknown) => (err as { code?: string }).code,
  );

describe('WebSearchService: the key (KBC-185)', () => {
  it('starts with none', async () => {
    const { service, firecrawl } = build();
    await service.load();
    expect(await service.settings()).toEqual({
      connected: false,
      keyHint: null,
      credits: null,
      low: false,
      checkedAt: null,
      problem: null,
    });
    expect(service.available()).toEqual({ connected: false, low: false });
    expect(await codeOf(service.search(REQUEST, NEW))).toBe(
      'WEB_SEARCH_NOT_CONNECTED',
    );
    expect(firecrawl.accountChecks).toEqual([]);
  });

  it('keeps a key Firecrawl accepts, sealed, with its balance', async () => {
    const { service, store } = build();
    expect(await service.connect(KEY, 'owner')).toEqual({
      connected: true,
      keyHint: 'alid',
      credits: {
        remaining: 1_000,
        plan: 1_000,
        periodEnd: '2026-12-15T12:00:00.000Z',
      },
      low: false,
      checkedAt: '2026-11-25T12:00:00.000Z',
      problem: null,
    });
    const stored = JSON.stringify(await store.read());
    expect(stored).toContain('enc:v1:');
    expect(stored).not.toContain(KEY);
  });

  it('keeps nothing when Firecrawl refuses the key or does not answer', async () => {
    const { service, firecrawl, store } = build();
    expect(await codeOf(service.connect('fc-wrong-key', 'owner'))).toBe(
      'WEB_SEARCH_KEY_REJECTED',
    );
    firecrawl.goDown();
    expect(await codeOf(service.connect(KEY, 'owner'))).toBe(
      'WEB_SEARCH_UNAVAILABLE',
    );
    expect(await store.read()).toBeNull();
  });

  it('keeps the working key when another one is refused', async () => {
    const { service } = build();
    await service.connect(KEY, 'owner');
    await codeOf(service.connect('fc-wrong-key', 'owner'));
    expect(service.available()).toEqual({ connected: true, low: false });
  });

  it('opens the key after a restart, and forgets one sealed by another server', async () => {
    const first = build();
    await first.service.connect(KEY, 'owner');
    const again = build({ store: first.store, sealer: first.sealer });
    await again.service.load();
    expect(await again.service.settings()).toMatchObject({
      connected: true,
      credits: { remaining: 1_000 },
    });
    const other = build({ store: first.store });
    await other.service.load();
    expect(await other.service.settings()).toMatchObject({
      connected: false,
      keyHint: null,
      problem: null,
    });
    expect(await codeOf(other.service.search(REQUEST, NEW))).toBe(
      'WEB_SEARCH_NOT_CONNECTED',
    );
  });

  it('ignores a file it cannot read, saying so', async () => {
    const store = new MemoryDocumentStore();
    await store.write({ version: 7 });
    const { service, log } = build({ store });
    await service.load();
    expect(service.available().connected).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('removes the key and what was known of it', async () => {
    const { service } = build();
    await service.connect('fc-low-valid', 'owner');
    expect(await service.disconnect()).toEqual({
      connected: false,
      keyHint: null,
      credits: null,
      low: false,
      checkedAt: null,
      problem: null,
    });
  });
});

describe('WebSearchService: the balance', () => {
  it('reads it again only when it is not fresh, once for two readers', async () => {
    const { service, firecrawl, later } = build();
    await service.connect(KEY, 'owner');
    await service.settings();
    expect(firecrawl.accountChecks).toHaveLength(1);
    later(SETTINGS_TTL_MS);
    await Promise.all([service.settings(), service.settings()]);
    expect(firecrawl.accountChecks).toHaveLength(2);
  });

  it('keeps the last balance while Firecrawl does not answer', async () => {
    const { service, firecrawl, later } = build();
    await service.connect(KEY, 'owner');
    firecrawl.goDown();
    later(SETTINGS_TTL_MS);
    expect(await service.settings()).toMatchObject({
      connected: true,
      credits: { remaining: 1_000 },
      checkedAt: '2026-11-25T12:00:00.000Z',
      problem: 'unreachable',
    });
    // Not answering now does not stop a search from trying.
    expect(service.available().connected).toBe(true);
    firecrawl.comeBack();
    later(SETTINGS_TTL_MS);
    expect((await service.settings()).problem).toBeNull();
  });

  it('says a key revoked in Firecrawl is refused, until another is pasted', async () => {
    const { service, firecrawl, later } = build();
    await service.connect(KEY, 'owner');
    firecrawl.revokeKeys();
    later(SETTINGS_TTL_MS);
    expect(await service.settings()).toMatchObject({
      connected: true,
      problem: 'key-rejected',
    });
    expect(service.available().connected).toBe(false);
    expect(await codeOf(service.search(REQUEST, NEW))).toBe(
      'WEB_SEARCH_NOT_CONNECTED',
    );
    expect(firecrawl.searches).toEqual([]);
  });

  it('drops the answer about a key removed while Firecrawl answered', async () => {
    const { service, later } = build();
    await service.connect(KEY, 'owner');
    later(SETTINGS_TTL_MS);
    const reading = service.settings();
    await service.disconnect();
    await reading;
    expect(await service.settings()).toMatchObject({
      connected: false,
      credits: null,
    });
  });

  it('warns under 100 credits, to everyone who searches', async () => {
    const { service } = build();
    expect(await service.connect('fc-low-valid', 'owner')).toMatchObject({
      credits: { remaining: 42 },
      low: true,
    });
    expect(service.available()).toEqual({ connected: true, low: true });
  });

  it('learns it in the background after a restart, without making anyone wait', async () => {
    const first = build();
    await first.service.connect('fc-low-valid', 'owner');
    const again = build({ store: first.store, sealer: first.sealer });
    await again.service.load();
    expect(again.service.available()).toEqual({ connected: true, low: false });
    await vi.waitFor(() =>
      expect(again.service.available()).toEqual({ connected: true, low: true }),
    );
    expect(again.firecrawl.accountChecks).toHaveLength(1);
  });

  it('logs, and does not crash, when the background reading cannot be kept', async () => {
    const store = new MemoryDocumentStore();
    const { service, firecrawl, later, log } = build({ store });
    await service.connect(KEY, 'owner');
    firecrawl.revokeKeys();
    later(60 * 60_000);
    vi.spyOn(store, 'write').mockRejectedValue(new Error('disk full'));
    service.available();
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledOnce());
  });
});

describe('WebSearchService: a search', () => {
  it('gives texts, audios and videos in turn, each with whether the collection has it', async () => {
    const { service } = build();
    await service.connect(KEY, 'owner');
    const found = await service.search(REQUEST, NEW);
    expect(found.results.map((one) => [one.kind, one.url])).toEqual([
      ['text', 'https://www.exemplo.org/hermetismo/1'],
      ['audio', 'https://soundcloud.com/alguem/hermetismo'],
      ['video', 'https://www.youtube.com/watch?v=aaaaaaaaaa1'],
      ['text', 'https://www.exemplo.org/hermetismo/2'],
      ['audio', 'https://archive.org/details/hermetismo'],
      ['video', 'https://www.youtube.com/watch?v=aaaaaaaaaa2'],
      ['text', 'https://www.exemplo.org/hermetismo/3'],
      ['video', 'https://vimeo.com/123456789'],
      ['text', 'https://www.exemplo.org/hermetismo/4'],
    ]);
    expect(found.results[0]).toEqual({
      kind: 'text',
      url: 'https://www.exemplo.org/hermetismo/1',
      title: 'hermetismo: texto 1',
      snippet: 'O que o texto 1 diz sobre hermetismo.',
      site: 'exemplo.org',
      author: null,
      already: null,
    });
    expect(found).toMatchObject({
      partial: false,
      exhausted: false,
      skipped: { already: 0, seen: 0 },
      creditsUsed: 6,
      creditsRemaining: 994,
      low: false,
    });
  });

  it('leaves out what the collection has, and shows it when asked again', async () => {
    const { service } = build();
    await service.connect(KEY, 'owner');
    const document = { id: 'raw/articles/x.md', title: 'X' };
    const context = {
      ...NEW,
      alreadyOf: (url: string) =>
        url.endsWith('hermetismo/2') ? { document } : null,
    };
    const request = { ...REQUEST, kinds: ['text' as const], sources: 4 };
    const found = await service.search(request, context);
    const urls = found.results.map((one) => one.url);
    expect(urls).toHaveLength(4);
    expect(urls).not.toContain('https://www.exemplo.org/hermetismo/2');
    expect(found.skipped.already).toBe(1);
    const again = await service.search({ ...request, again: true }, context);
    expect(
      again.results.find((one) => one.url.endsWith('hermetismo/2'))?.already,
    ).toEqual({ document });
  });

  it('goes on, in other words, until it has the sources wanted', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const found = await service.search({ ...REQUEST, sources: 20 }, NEW);
    expect(found.results).toHaveLength(20);
    expect(new Set(found.results.map((one) => one.url)).size).toBe(20);
    expect(firecrawl.searches.length).toBeGreaterThan(3);
    expect(firecrawl.searches.every(({ body }) => body['limit'] === 10)).toBe(
      true,
    );
  });

  it('asked again gives what comes next, what was found first and not given yet for free', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const request = { ...REQUEST, sources: 4 };
    const first = await service.search(request, NEW);
    const paid = firecrawl.searches.length;
    const second = await service.search(request, NEW);
    expect(firecrawl.searches).toHaveLength(paid);
    expect(second.creditsUsed).toBe(0);
    const third = await service.search({ ...request, sources: 9 }, NEW);
    const all = [first, second, third].flatMap(({ results }) =>
      results.map((one) => one.url),
    );
    expect(all).toHaveLength(17);
    expect(new Set(all).size).toBe(17);
  });

  it('never gives again what it gave, after a restart too, unless asked', async () => {
    const seen = new MemoryDocumentStore();
    const first = build({ seen });
    await first.service.connect(KEY, 'owner');
    const given = await first.service.search(REQUEST, NEW);
    const later = build({ ...first, seen });
    await later.service.load();
    const next = await later.service.search(REQUEST, NEW);
    const before = new Set(given.results.map((one) => one.url));
    expect(next.results.some((one) => before.has(one.url))).toBe(false);
    expect(next.skipped.seen).toBe(9);
    // Another person, or another collection, was given nothing yet.
    const beto = { ...NEW, principal: 'beto' };
    expect((await later.service.search(REQUEST, beto)).skipped.seen).toBe(0);
    const again = await later.service.search({ ...REQUEST, again: true }, NEW);
    expect(again.results.map((one) => one.url)).toEqual(
      given.results.map((one) => one.url),
    );
  });

  it('says when nothing else is found', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    // The fake finds the same three videos, whatever the words.
    const request = { ...REQUEST, kinds: ['video' as const], sources: 30 };
    const found = await service.search(request, NEW);
    expect(found.results).toHaveLength(3);
    expect(found.exhausted).toBe(true);
    // Two rounds with nothing new are enough.
    expect(firecrawl.searches).toHaveLength(3);
    const more = await service.search(request, NEW);
    expect(more).toMatchObject({ results: [], exhausted: true });
    expect(firecrawl.searches).toHaveLength(3);
  });

  it('makes one search, and spends for one, when one kind is asked', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const found = await service.search(
      { ...REQUEST, kinds: ['video'], sources: 3 },
      NEW,
    );
    expect(firecrawl.searches).toHaveLength(1);
    expect(found.results.every((one) => one.kind === 'video')).toBe(true);
    expect(found.creditsUsed).toBe(2);
  });

  it('searches for each author by name, unquoted, and says who each result names', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const found = await service.search(
      {
        ...REQUEST,
        kinds: ['text', 'video'],
        authors: ['Manly "P." Hall', 'Hermes'],
      },
      NEW,
    );
    expect(firecrawl.searches.map(({ body }) => body['query'])).toEqual([
      'hermetismo Manly P. Hall',
      'hermetismo Manly P. Hall',
      'hermetismo Hermes',
      'hermetismo Hermes',
    ]);
    const authors = new Set(
      found.results
        .filter((one) => one.kind === 'text')
        .map((one) => one.author),
    );
    expect([...authors]).toEqual(['Manly "P." Hall', 'Hermes']);
    // Both found the same three videos: each is there once, for one of them.
    const videos = found.results.filter((one) => one.kind === 'video');
    expect(new Set(videos.map((one) => one.url)).size).toBe(videos.length);
    expect(found.creditsUsed).toBe(8);
  });

  it('gives what the others found when a search does not answer', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.breakSearchesOf('video', 'audio');
    const found = await service.search(REQUEST, NEW);
    expect(found.results).toHaveLength(4);
    expect(found).toMatchObject({ partial: true, creditsUsed: 2 });
    // Asked again, what did not answer comes first; failing again it is let go.
    const asked = firecrawl.searches.length;
    await service.search(REQUEST, NEW);
    const kinds = firecrawl.searches
      .slice(asked, asked + 2)
      .map(({ body }) => body['includeDomains']);
    expect(kinds).toEqual([['podcasts.apple.com'], ['youtube.com']]);
    const third = await service.search(REQUEST, NEW);
    expect(third.results.length).toBeGreaterThan(0);
  });

  it('gives none, saying it is partial, when one found nothing and another did not answer', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.breakSearchesOf('video');
    const found = await service.search({ ...REQUEST, query: 'vazio' }, NEW);
    expect(found).toMatchObject({ results: [], partial: true });
  });

  it('gives none when nothing was found, and it is the whole answer', async () => {
    const { service } = build();
    await service.connect(KEY, 'owner');
    const found = await service.search({ ...REQUEST, query: 'vazio' }, NEW);
    expect(found).toMatchObject({
      results: [],
      partial: false,
      exhausted: true,
      // Two rounds, three kinds: nothing new twice is the end.
      creditsUsed: 12,
    });
  });

  it('says there are no credits left, and remembers it', async () => {
    const { service } = build();
    await service.connect('fc-empty-valid', 'owner');
    expect(await codeOf(service.search(REQUEST, NEW))).toBe(
      'WEB_SEARCH_NO_CREDITS',
    );
    expect(service.available()).toEqual({ connected: true, low: true });
  });

  it('knows there are none even when it never read the balance', async () => {
    const first = build();
    await first.service.connect('fc-empty-valid', 'owner');
    const again = build({ store: first.store, sealer: first.sealer });
    await again.service.load();
    await codeOf(again.service.search(REQUEST, NEW));
    expect(again.service.available().low).toBe(true);
  });

  it('passes on how long Firecrawl asked to wait', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.rateLimitNext(3);
    await expect(service.search(REQUEST, NEW)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 7 },
    });
  });

  it('keeps what was found before it had to wait', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.rateLimitNext(1);
    const found = await service.search(REQUEST, NEW);
    expect(found.partial).toBe(true);
    expect(found.results.length).toBeGreaterThan(0);
  });

  it('says it must wait when nothing else found anything', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.rateLimitNext(1);
    expect(
      await codeOf(service.search({ ...REQUEST, query: 'vazio' }, NEW)),
    ).toBe('RATE_LIMITED');
  });

  it('says Firecrawl is down', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.goDown();
    expect(await codeOf(service.search(REQUEST, NEW))).toBe(
      'WEB_SEARCH_UNAVAILABLE',
    );
  });

  it('stops searching with a key refused in the middle, and the settings say it', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.revokeKeys();
    expect(await codeOf(service.search(REQUEST, NEW))).toBe(
      'WEB_SEARCH_NOT_CONNECTED',
    );
    expect(service.available().connected).toBe(false);
    expect((await service.settings()).problem).toBe('key-rejected');
  });

  it('does not blame the new key for the one it replaced', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const searching = service.search(REQUEST, NEW);
    await service.connect('fc-other-key-valid', 'owner');
    await searching;
    expect(await service.settings()).toMatchObject({
      credits: { remaining: 1_000 },
      problem: null,
    });
    expect(firecrawl.searches).toHaveLength(3);
  });

  it('never logs the key or what was searched', async () => {
    const { service, firecrawl, log } = build();
    await service.connect(KEY, 'owner');
    const request = { ...REQUEST, authors: ['Trismegisto'] };
    await service.search(request, NEW);
    firecrawl.goDown();
    await codeOf(service.search(request, NEW));
    const lines = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    expect(lines).toContain('unreachable');
    for (const secret of [KEY, request.query, 'Trismegisto'])
      expect(lines).not.toContain(secret);
  });
});

describe('WebSearchService: many searches of one request', () => {
  const FIFTEEN = {
    ...REQUEST,
    sources: 5,
    authors: ['Ana', 'Bia', 'Caio', 'Davi', 'Eva'],
  };

  /** A service whose every search takes a moment and answers as told. */
  async function slow(answerOf: (asked: number) => WebSearchAnswer) {
    const asked: WebSearchQuery[] = [];
    const running = { now: 0, most: 0 };
    const web: WebSearchPort = {
      account: async () => ({
        kind: 'ok',
        balance: { remaining: 1_000, plan: null, periodEnd: null },
      }),
      search: async (query) => {
        asked.push(query);
        const answer = answerOf(asked.length);
        running.now++;
        running.most = Math.max(running.most, running.now);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running.now--;
        return answer;
      },
    };
    const service = new WebSearchService({
      store: new MemoryDocumentStore(),
      sealer: new SecretBox(randomBytes(32)),
      web,
      seen: new SeenLinks(new MemoryDocumentStore()),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await service.connect(KEY, 'owner');
    return { service, asked, running };
  }

  const hit = (at: number): WebSearchAnswer => ({
    kind: 'ok',
    hits: [
      {
        url: `https://exemplo.org/${at}`,
        title: 'Hermetismo',
        description: '',
      },
    ],
    creditsUsed: 2,
  });

  it('makes every one, four at once, and adds up what they cost', async () => {
    const { service, asked, running } = await slow(hit);
    const found = await service.search(
      { ...FIFTEEN, kinds: ['text', 'audio', 'video'] },
      NEW,
    );
    expect(asked).toHaveLength(15);
    expect(running.most).toBe(4);
    expect(found).toMatchObject({ partial: false, creditsUsed: 30 });
    // Only the texts are on a site a text may come from: one for each author.
    expect(found.results.map((one) => one.kind)).toEqual(
      FIFTEEN.authors.map(() => 'text'),
    );
  });

  it.each([
    { kind: 'no-credits' as const },
    { kind: 'key-rejected' as const },
    { kind: 'rate-limited' as const, retryAfterMs: 1_000 },
  ])('makes no other after $kind', async (failure) => {
    const { service, asked } = await slow((at) =>
      at === 1 ? hit(at) : failure,
    );
    const found = await service.search(FIFTEEN, NEW);
    expect(asked.length).toBeLessThanOrEqual(5);
    expect(found).toMatchObject({ partial: true, creditsUsed: 2 });
    expect(found.results).toHaveLength(1);
  });

  it('goes on after one that did not answer', async () => {
    const { service, asked } = await slow((at) =>
      at === 2 ? { kind: 'unreachable', status: null } : hit(at),
    );
    const found = await service.search(FIFTEEN, NEW);
    expect(asked).toHaveLength(15);
    expect(found).toMatchObject({ partial: true, creditsUsed: 28 });
  });
});

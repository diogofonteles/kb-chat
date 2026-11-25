import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FirecrawlClient } from '../../adapters/firecrawl-client.js';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { SecretBox } from '../../adapters/secret-box.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { FakeFirecrawl } from '../../testing/fake-firecrawl.js';
import { SETTINGS_TTL_MS, WebSearchService } from './index.js';

const KEY = 'fc-house-key-valid';
const REQUEST = {
  query: 'hermetismo',
  kinds: ['page' as const, 'video' as const],
  limit: 10,
};
const NEW = () => null;

function build(
  options: { store?: DocumentStorePort; sealer?: SecretBox } = {},
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
  it('gives pages, then real videos, each with whether the collection has it', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const document = { id: 'raw/articles/x.md', title: 'X' };
    const found = await service.search(REQUEST, (url) =>
      url.endsWith('/2') ? { document } : null,
    );
    expect(found.results.map((one) => [one.kind, one.url])).toEqual([
      ['page', 'https://www.exemplo.org/hermetismo/1'],
      ['page', 'https://www.exemplo.org/hermetismo/2'],
      ['page', 'https://www.exemplo.org/hermetismo/3'],
      ['page', 'https://www.exemplo.org/hermetismo/4'],
      ['video', 'https://www.youtube.com/watch?v=aaaaaaaaaa1'],
      ['video', 'https://www.youtube.com/watch?v=aaaaaaaaaa2'],
      ['video', 'https://vimeo.com/123456789'],
    ]);
    expect(found.results[0]).toMatchObject({
      title: 'hermetismo: página 1',
      snippet: 'O que a página 1 diz sobre hermetismo.',
      site: 'exemplo.org',
      already: null,
    });
    expect(found.results[1]?.already).toEqual({ document });
    expect(found).toMatchObject({
      failedKinds: [],
      creditsUsed: 4,
      creditsRemaining: 996,
      low: false,
    });
    expect(
      firecrawl.searches.map(({ body }) => body['includeDomains']),
    ).toEqual([undefined, ['youtube.com', 'vimeo.com']]);
  });

  it('makes one call, and spends for one, when one kind is asked', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    const found = await service.search({ ...REQUEST, kinds: ['video'] }, NEW);
    expect(firecrawl.searches).toHaveLength(1);
    expect(found.results.every((one) => one.kind === 'video')).toBe(true);
    expect(found.creditsUsed).toBe(2);
  });

  it('gives what one kind found, naming the kind that failed', async () => {
    const { service, firecrawl } = build();
    await service.connect(KEY, 'owner');
    firecrawl.breakSearchesOf('video');
    const found = await service.search(REQUEST, NEW);
    expect(found.results).toHaveLength(4);
    expect(found).toMatchObject({ failedKinds: ['video'], creditsUsed: 2 });
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
    firecrawl.rateLimitNext(2);
    await expect(service.search(REQUEST, NEW)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 7 },
    });
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
    expect(firecrawl.searches).toHaveLength(2);
  });

  it('never logs the key or what was searched', async () => {
    const { service, firecrawl, log } = build();
    await service.connect(KEY, 'owner');
    await service.search(REQUEST, NEW);
    firecrawl.goDown();
    await codeOf(service.search(REQUEST, NEW));
    const lines = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    expect(lines).toContain('unreachable');
    expect(lines).not.toContain(KEY);
    expect(lines).not.toContain(REQUEST.query);
  });
});

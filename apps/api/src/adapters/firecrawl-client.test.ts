import { describe, expect, it, vi } from 'vitest';
import { FakeFirecrawl } from '../testing/fake-firecrawl.js';
import { FirecrawlClient } from './firecrawl-client.js';

const KEY = 'fc-test-key-valid';
const QUERY = { key: KEY, query: 'hermetismo', limit: 10 };

/** A client whose every request gets this answer. */
const answering = (response: () => Response) =>
  new FirecrawlClient({ fetch: async () => response() });

describe('FirecrawlClient.search (KBC-185)', () => {
  it('asks for web results in Brazil, the key only in the header', async () => {
    const firecrawl = new FakeFirecrawl();
    const fetch = vi.fn(firecrawl.fetch);
    const client = new FirecrawlClient({ fetch });
    const answer = await client.search(QUERY);
    expect(answer).toMatchObject({ kind: 'ok', creditsUsed: 2 });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.firecrawl.dev/v2/search');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${KEY}`,
    );
    expect(firecrawl.searches[0]?.body).toEqual({
      query: 'hermetismo',
      limit: 10,
      sources: [{ type: 'web' }],
      country: 'BR',
      ignoreInvalidURLs: true,
    });
    expect(String(init?.body)).not.toContain(KEY);
  });

  it('searches only the sites asked for', async () => {
    const firecrawl = new FakeFirecrawl();
    const client = new FirecrawlClient({ fetch: firecrawl.fetch });
    await client.search({ ...QUERY, domains: ['youtube.com', 'vimeo.com'] });
    expect(firecrawl.searches[0]?.body).toMatchObject({
      includeDomains: ['youtube.com', 'vimeo.com'],
    });
  });

  it('reads the hits, leaving out the ones without an address', async () => {
    const client = answering(() =>
      Response.json({
        success: true,
        data: {
          web: [
            { url: 'https://a.org/1', title: 'A', description: 'Sobre A' },
            { title: 'Sem endereço' },
            { url: 'https://a.org/2', title: null },
          ],
        },
        creditsUsed: 2,
      }),
    );
    expect(await client.search(QUERY)).toEqual({
      kind: 'ok',
      creditsUsed: 2,
      hits: [
        { url: 'https://a.org/1', title: 'A', description: 'Sobre A' },
        { url: 'https://a.org/2', title: '', description: '' },
      ],
    });
  });

  it('takes an answer with no results and no credits as none found', async () => {
    const client = answering(() => Response.json({ success: true, data: {} }));
    expect(await client.search(QUERY)).toEqual({
      kind: 'ok',
      hits: [],
      creditsUsed: 0,
    });
  });

  it.each([
    [401, { kind: 'key-rejected' }],
    [403, { kind: 'key-rejected' }],
    [402, { kind: 'no-credits' }],
    [408, { kind: 'unreachable', status: 408 }],
    [500, { kind: 'unreachable', status: 500 }],
    [503, { kind: 'unreachable', status: 503 }],
  ])('maps HTTP %i', async (status, expected) => {
    const client = answering(() => new Response('{}', { status }));
    expect(await client.search(QUERY)).toEqual(expected);
  });

  it('maps 429 with the wait Firecrawl asked for', async () => {
    const client = answering(
      () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
    );
    expect(await client.search(QUERY)).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 7_000,
    });
  });

  it('is unreachable when the network fails, the body breaks or is not the contract', async () => {
    const down = new FirecrawlClient({
      fetch: () => Promise.reject(new TypeError('ECONNREFUSED')),
    });
    expect(await down.search(QUERY)).toEqual({
      kind: 'unreachable',
      status: null,
    });
    for (const body of ['{"success": tr', '{"success":false}', '[]']) {
      const odd = answering(() => new Response(body, { status: 200 }));
      expect(await odd.search(QUERY)).toEqual({
        kind: 'unreachable',
        status: 200,
      });
    }
  });

  it('gives up after its time limit', async () => {
    const limits: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      limits.push(ms);
      return AbortSignal.abort();
    });
    const client = new FirecrawlClient({
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return new Response('{}');
      },
    });
    expect(await client.search(QUERY)).toEqual({
      kind: 'unreachable',
      status: null,
    });
    expect(await client.account(KEY)).toEqual({
      kind: 'unreachable',
      status: null,
    });
    expect(limits).toEqual([30_000, 15_000]);
  });
});

describe('FirecrawlClient.account', () => {
  it('reads the balance', async () => {
    const firecrawl = new FakeFirecrawl();
    const fetch = vi.fn(firecrawl.fetch);
    expect(await new FirecrawlClient({ fetch }).account(KEY)).toEqual({
      kind: 'ok',
      balance: {
        remaining: 1_000,
        plan: 1_000,
        periodEnd: '2026-12-15T12:00:00.000Z',
      },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.firecrawl.dev/v2/team/credit-usage',
    );
  });

  it('keeps a balance whose plan or period is not said, and never a negative one', async () => {
    const client = answering(() =>
      Response.json({
        success: true,
        data: {
          remainingCredits: -3,
          planCredits: null,
          billingPeriodEnd: null,
        },
      }),
    );
    expect(await client.account(KEY)).toEqual({
      kind: 'ok',
      balance: { remaining: 0, plan: null, periodEnd: null },
    });
  });

  it('gives the end of the period in UTC, and none when it is not a date', async () => {
    const at = (billingPeriodEnd: unknown) =>
      answering(() =>
        Response.json({
          success: true,
          data: { remainingCredits: 5, billingPeriodEnd },
        }),
      ).account(KEY);
    expect(await at('2026-12-15T09:00:00-03:00')).toMatchObject({
      balance: { periodEnd: '2026-12-15T12:00:00.000Z' },
    });
    expect(await at('amanhã')).toMatchObject({ balance: { periodEnd: null } });
  });

  it('says a key is refused, or that nothing answered', async () => {
    const firecrawl = new FakeFirecrawl();
    const client = new FirecrawlClient({ fetch: firecrawl.fetch });
    expect(await client.account('fc-wrong')).toEqual({ kind: 'key-rejected' });
    firecrawl.goDown();
    expect(await client.account(KEY)).toEqual({
      kind: 'unreachable',
      status: null,
    });
  });
});

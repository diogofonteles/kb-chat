/** One search request as Firecrawl received it. */
export interface FirecrawlSearchCall {
  readonly key: string;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Hit {
  readonly url: string;
  readonly title: string;
  readonly description: string;
}

const CREDITS_PER_SEARCH = 2;
const PLAN_CREDITS = 1_000;
const PERIOD_END = '2026-12-15T12:00:00.000Z';

const slugOf = (query: string): string =>
  query
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const pages = (query: string): Hit[] =>
  Array.from({ length: 4 }, (_, at) => ({
    url: `https://www.exemplo.org/${slugOf(query)}/${at + 1}`,
    title: `${query}: página ${at + 1}`,
    description: `O que a página ${at + 1} diz sobre ${query}.`,
  }));

const VIDEO_IDS = ['aaaaaaaaaa1', 'aaaaaaaaaa2'];

/** Two real videos between a channel and a playlist, as Firecrawl mixes them. */
const videos = (query: string): Hit[] => [
  {
    url: 'https://www.youtube.com/@canal',
    title: `Canal sobre ${query}`,
    description: 'Um canal, que não é um vídeo.',
  },
  ...VIDEO_IDS.map((id, at) => ({
    url: `https://www.youtube.com/watch?v=${id}&t=12s`,
    title: `${query}: vídeo ${at + 1}`,
    description: `Um vídeo sobre ${query}.`,
  })),
  {
    url: 'https://vimeo.com/123456789',
    title: `${query}: vídeo do Vimeo`,
    description: `Um filme sobre ${query}.`,
  },
];

/**
 * Firecrawl's search and account without the network (KBC-185): a key ending in "valid" is
 * accepted, any other gets 401. The key also says what its account has: one with "low" 42
 * credits, one with "empty" none (a search gets 402), any other 1 000. A query with "vazio"
 * finds nothing.
 */
export class FakeFirecrawl {
  readonly searches: FirecrawlSearchCall[] = [];
  readonly accountChecks: string[] = [];
  private readonly spent = new Map<string, number>();
  private revoked = false;
  private down = false;
  private limited = 0;
  private broken: 'page' | 'video' | null = null;

  /** Every key is refused from now on, as if revoked in Firecrawl's dashboard. */
  revokeKeys(): void {
    this.revoked = true;
  }

  /** Nothing answers any more. */
  goDown(): void {
    this.down = true;
  }

  comeBack(): void {
    this.down = false;
  }

  /** The next searches are 429, then normal again. */
  rateLimitNext(times: number): void {
    this.limited = times;
  }

  /** The searches of one kind fail with a 500. */
  breakSearchesOf(kind: 'page' | 'video'): void {
    this.broken = kind;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    const request = new Request(String(input), init);
    const key = (request.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    );
    if (new URL(request.url).pathname.endsWith('/team/credit-usage')) {
      this.accountChecks.push(key);
      return this.accepts(key) ? this.account(key) : refused();
    }
    return this.accepts(key) ? this.search(request, key) : refused();
  };

  private accepts(key: string): boolean {
    return !this.revoked && key.endsWith('valid');
  }

  private account(key: string): Response {
    return Response.json({
      success: true,
      data: {
        remainingCredits: this.remaining(key),
        planCredits: PLAN_CREDITS,
        billingPeriodStart: '2026-11-15T12:00:00.000Z',
        billingPeriodEnd: PERIOD_END,
      },
    });
  }

  private remaining(key: string): number {
    const given = key.includes('low') ? 42 : key.includes('empty') ? 0 : 1_000;
    return Math.max(0, given - (this.spent.get(key) ?? 0));
  }

  private async search(request: Request, key: string): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    this.searches.push({ key, body });
    if (this.limited > 0) {
      this.limited--;
      return Response.json(
        { success: false, error: 'Rate limit exceeded' },
        { status: 429, headers: { 'retry-after': '7' } },
      );
    }
    const kind = body['includeDomains'] ? 'video' : 'page';
    if (this.broken === kind) return new Response('oops', { status: 500 });
    if (this.remaining(key) === 0)
      return Response.json(
        { success: false, error: 'Insufficient credits' },
        { status: 402 },
      );
    return this.found(key, { kind, query: String(body['query']) });
  }

  private found(
    key: string,
    { kind, query }: { kind: 'page' | 'video'; query: string },
  ): Response {
    this.spent.set(key, (this.spent.get(key) ?? 0) + CREDITS_PER_SEARCH);
    const hits = kind === 'video' ? videos(query) : pages(query);
    return Response.json({
      success: true,
      data: { web: query.includes('vazio') ? [] : hits },
      creditsUsed: CREDITS_PER_SEARCH,
    });
  }
}

const refused = () =>
  Response.json(
    { success: false, error: 'Unauthorized: Invalid token' },
    { status: 401 },
  );

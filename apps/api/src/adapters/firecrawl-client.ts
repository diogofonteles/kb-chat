import { z } from 'zod';
import type {
  WebSearchAccount,
  WebSearchAnswer,
  WebSearchFailure,
  WebSearchPort,
  WebSearchQuery,
} from '../ports/web-search.js';
import { retryAfterMsOf } from './groq-client.js';

export const FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v2';
/** Firecrawl's own searches take a few seconds. */
const SEARCH_TIMEOUT_MS = 30_000;
const ACCOUNT_TIMEOUT_MS = 15_000;

const hitSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});

const searchSchema = z.object({
  success: z.literal(true),
  data: z.object({ web: z.array(z.unknown()).nullish() }),
  creditsUsed: z.number().min(0).catch(0),
});

const accountSchema = z.object({
  success: z.literal(true),
  data: z.object({
    remainingCredits: z.number().transform((credits) => Math.max(0, credits)),
    planCredits: z.number().min(0).nullish().catch(null),
    billingPeriodEnd: z.string().nullish().catch(null),
  }),
});

type Read<T> = { readonly kind: 'ok'; readonly body: T } | WebSearchFailure;

/** Firecrawl's v2 API over `fetch`; the key goes only in the header. */
export class FirecrawlClient implements WebSearchPort {
  constructor(
    private readonly options: {
      readonly fetch?: typeof fetch;
      readonly baseUrl?: string;
    } = {},
  ) {}

  async search(query: WebSearchQuery): Promise<WebSearchAnswer> {
    const read = await this.read(searchSchema, '/search', {
      method: 'POST',
      headers: { ...bearer(query.key), 'content-type': 'application/json' },
      body: JSON.stringify(searchBody(query)),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (read.kind !== 'ok') return read;
    const { data, creditsUsed } = read.body;
    return { kind: 'ok', hits: (data.web ?? []).flatMap(hitOf), creditsUsed };
  }

  async account(key: string): Promise<WebSearchAccount> {
    const read = await this.read(accountSchema, '/team/credit-usage', {
      method: 'GET',
      headers: bearer(key),
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
    if (read.kind !== 'ok') return read;
    const { remainingCredits, planCredits, billingPeriodEnd } = read.body.data;
    return {
      kind: 'ok',
      balance: {
        remaining: remainingCredits,
        plan: planCredits ?? null,
        periodEnd: isoOf(billingPeriodEnd),
      },
    };
  }

  /** One request, its body read by `schema`; whatever goes wrong is a failure, never a throw. */
  private async read<T>(
    schema: z.ZodType<T>,
    path: string,
    init: RequestInit,
  ): Promise<Read<T>> {
    let response: Response;
    try {
      const doFetch = this.options.fetch ?? fetch;
      const base = this.options.baseUrl ?? FIRECRAWL_API_URL;
      response = await doFetch(`${base}${path}`, init);
    } catch {
      return { kind: 'unreachable', status: null };
    }
    if (!response.ok) return failureOf(response);
    const parsed = schema.safeParse(await jsonOf(response));
    return parsed.success
      ? { kind: 'ok', body: parsed.data }
      : { kind: 'unreachable', status: response.status };
  }
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const searchBody = ({ query, limit, domains }: WebSearchQuery) => ({
  query,
  limit,
  sources: [{ type: 'web' }],
  country: 'BR',
  ignoreInvalidURLs: true,
  ...(domains && { includeDomains: domains }),
});

const hitOf = (raw: unknown) => {
  const hit = hitSchema.safeParse(raw);
  if (!hit.success) return [];
  const { url, title, description } = hit.data;
  return [{ url, title: title ?? '', description: description ?? '' }];
};

async function failureOf(response: Response): Promise<WebSearchFailure> {
  await response.body?.cancel();
  const { status } = response;
  if (status === 401 || status === 403) return { kind: 'key-rejected' };
  if (status === 402) return { kind: 'no-credits' };
  if (status === 429)
    return {
      kind: 'rate-limited',
      retryAfterMs: retryAfterMsOf(response.headers.get('retry-after')),
    };
  return { kind: 'unreachable', status };
}

/** The body, or undefined when it is cut short or not JSON (the schema then refuses it). */
async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isoOf(date: string | null | undefined): string | null {
  const at = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** Why the search engine gave no answer (KBC-185); the key and the query are in none of them. */
export type WebSearchFailure =
  | { readonly kind: 'key-rejected' }
  | { readonly kind: 'no-credits' }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number }
  /** `status` is null when nothing answered; a 200 here is an answer that could not be read. */
  | { readonly kind: 'unreachable'; readonly status: number | null };

/** One result as the engine gave it. */
export interface WebHit {
  readonly url: string;
  readonly title: string;
  readonly description: string;
}

export interface WebSearchQuery {
  readonly key: string;
  readonly query: string;
  readonly limit: number;
  /** Only these sites. */
  readonly domains?: readonly string[];
}

export type WebSearchAnswer =
  | {
      readonly kind: 'ok';
      readonly hits: readonly WebHit[];
      readonly creditsUsed: number;
    }
  | WebSearchFailure;

/** The account's balance. */
export interface WebSearchBalance {
  readonly remaining: number;
  readonly plan: number | null;
  readonly periodEnd: string | null;
}

export type WebSearchAccount =
  | { readonly kind: 'ok'; readonly balance: WebSearchBalance }
  | WebSearchFailure;

/** A web search engine (Firecrawl, docs.firecrawl.dev v2); a fake in tests. */
export interface WebSearchPort {
  search(query: WebSearchQuery): Promise<WebSearchAnswer>;
  /** The balance of `key`: it costs nothing, so it is also how a key is tested. */
  account(key: string): Promise<WebSearchAccount>;
}

import {
  WEB_SEARCH_LOW_CREDITS,
  type WebSearchAvailability,
  type WebSearchCredits,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
  type WebSearchSettings,
} from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import type { SecretSealerPort } from '../../ports/secret-sealer.js';
import type {
  WebSearchAccount,
  WebSearchAnswer,
  WebSearchFailure,
  WebSearchPort,
} from '../../ports/web-search.js';
import {
  candidatesOf,
  interleave,
  pageKey,
  type Candidate,
} from './candidates.js';
import { AnswerCache } from './answer-cache.js';
import { RESULTS_PER_SEARCH, type SearchGroup } from './search-plan.js';
import { SearchSessions, type SearchSession } from './search-session.js';
import type { SeenLinks, Searcher } from './seen-links.js';
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  webSearchConfigSchema,
  type WebSearchConfig,
} from './web-search-config.js';

/** Where the sealed key lives (bound to its ciphertext, ADR 0017). */
const KEY_CONTEXT = 'web-search:firecrawl-key';
/** A master's screen reads the balance again after this long; the others, in the background. */
export const SETTINGS_TTL_MS = 30_000;
export const AVAILABLE_TTL_MS = 10 * 60_000;

/** Firecrawl searches of one request at once. */
export const SEARCHES_AT_ONCE = 4;
/** No round starts after this: the answer goes, and the screen asks for the rest. */
export const ROUNDS_BUDGET_MS = 20_000;

/** Whether the collection already has a link, for the person asking. */
export type AlreadyOf = (url: string) => WebSearchResult['already'];

/** Who searches, for which collection, and what it already has. */
export interface SearchContext extends Searcher {
  readonly alreadyOf: AlreadyOf;
  /** The person left: nothing else is asked, and nothing is taken as given. */
  readonly signal?: AbortSignal;
}

export interface WebSearchServiceDeps {
  readonly store: DocumentStorePort;
  readonly sealer: SecretSealerPort;
  readonly web: WebSearchPort;
  readonly seen: SeenLinks;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  readonly now?: () => Date;
}

/** What is known of the account behind the stored key (in memory). */
interface Known {
  readonly credits: WebSearchCredits | null;
  readonly checkedAt: string | null;
  readonly unreachable: boolean;
  /** When the account was last asked, answered or not. */
  readonly askedAt: number;
}

const UNKNOWN: Known = {
  credits: null,
  checkedAt: null,
  unreachable: false,
  askedAt: Number.NEGATIVE_INFINITY,
};

/** A search of the request and its answer. */
interface GroupAnswer {
  readonly group: SearchGroup;
  readonly answer: WebSearchAnswer;
}

/** One search under way. */
interface Search {
  readonly request: WebSearchRequest;
  readonly context: SearchContext;
  readonly session: SearchSession;
}

/** What asking again, now, would only be told again. */
const STOPS = new Set<WebSearchAnswer['kind']>([
  'key-rejected',
  'no-credits',
  'rate-limited',
]);

const notConnected = () =>
  new AppError('WEB_SEARCH_NOT_CONNECTED', 'The web search has no usable key');
/** Said to no one: the person who asked is gone. */
const stopped = () =>
  new AppError('WEB_SEARCH_UNAVAILABLE', 'The search was stopped');
const unavailable = () =>
  new AppError('WEB_SEARCH_UNAVAILABLE', 'The web search did not answer');

/** What a search that found nothing says, the gravest failure first. */
const ERRORS: {
  readonly [K in WebSearchFailure['kind']]: (
    failure: Extract<WebSearchFailure, { kind: K }>,
  ) => AppError;
} = {
  'key-rejected': notConnected,
  'no-credits': () =>
    new AppError('WEB_SEARCH_NO_CREDITS', 'The web search has no credits left'),
  'rate-limited': ({ retryAfterMs }) =>
    new AppError('RATE_LIMITED', 'The web search asked to wait', {
      details: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
    }),
  unreachable: unavailable,
};
const GRAVEST = Object.keys(ERRORS) as WebSearchFailure['kind'][];

function errorOf(failures: readonly WebSearchFailure[]): AppError | null {
  const [first] = [...failures].sort(
    (a, b) => GRAVEST.indexOf(a.kind) - GRAVEST.indexOf(b.kind),
  );
  if (!first) return null;
  const error = ERRORS[first.kind] as (failure: WebSearchFailure) => AppError;
  return error(first);
}

/**
 * Searching the web for what to add to a collection (KBC-185, KBC-009 R5): the house's
 * Firecrawl key, sealed and never sent back, its balance, and the search itself. Only
 * candidates come out; nothing is added. Neither the key nor what was searched is logged.
 */
export class WebSearchService {
  private config: WebSearchConfig = DEFAULT_WEB_SEARCH_CONFIG;
  private writing: Promise<unknown> = Promise.resolve();
  private known: Known = UNKNOWN;
  private checking: Promise<void> | null = null;
  private readonly sessions = new SearchSessions();
  private readonly answers = new AnswerCache();
  private readonly now: () => Date;

  constructor(private readonly deps: WebSearchServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    await this.deps.seen.load();
    const raw = await this.deps.store.read();
    const parsed = webSearchConfigSchema.safeParse(raw ?? {});
    if (!parsed.success)
      this.deps.log.warn('web-search.json is invalid; ignored');
    this.config = parsed.success ? parsed.data : DEFAULT_WEB_SEARCH_CONFIG;
  }

  /** The masters' view, the balance read again when it is not fresh. */
  async settings(): Promise<WebSearchSettings> {
    await this.refresh(SETTINGS_TTL_MS);
    return this.view();
  }

  /** For anyone who may search: what is known now, never waiting for Firecrawl. */
  available(): WebSearchAvailability {
    this.refresh(AVAILABLE_TTL_MS).catch((err: unknown) =>
      this.deps.log.error({ err }, 'web search: the balance was not kept'),
    );
    return { connected: this.usableKey() !== null, low: this.isLow() };
  }

  /** A pasted key is tested first, and kept (sealed) only when Firecrawl accepts it. */
  async connect(key: string, by: string): Promise<WebSearchSettings> {
    const account = await this.deps.web.account(key);
    if (account.kind === 'key-rejected')
      throw new AppError('WEB_SEARCH_KEY_REJECTED', 'The key was refused');
    if (account.kind !== 'ok') {
      this.warn('account', account);
      throw unavailable();
    }
    const connection = {
      key: this.deps.sealer.seal(key, KEY_CONTEXT),
      last4: key.slice(-4),
      keyRejected: false,
      connectedAt: this.now().toISOString(),
      connectedBy: by,
    };
    await this.change((config) => ({ ...config, connection }));
    this.known = this.learned(account);
    return this.view();
  }

  async disconnect(): Promise<WebSearchSettings> {
    await this.change((config) => ({ ...config, connection: null }));
    this.known = UNKNOWN;
    return this.view();
  }

  /**
   * Round after round (a search per kind and author, each round in other words) until the
   * sources wanted are found, nothing new comes, or the answer would take too long. What the
   * collection has and what the person was already given stay out, unless `again` asks. With
   * nothing found and a search refused, why is said instead.
   */
  async search(
    request: WebSearchRequest,
    context: SearchContext,
  ): Promise<WebSearchResponse> {
    const key = this.usableKey();
    const sealed = this.config.connection?.key;
    if (key === null || sealed === undefined) throw notConnected();
    const session = this.sessions.of(context, request, this.now().getTime());
    return session.oneAtATime(() =>
      this.searchIn({ request, context, session }, { key, sealed }),
    );
  }

  private async searchIn(
    search: Search,
    { key, sealed }: { readonly key: string; readonly sealed: string },
  ): Promise<WebSearchResponse> {
    const { context, session } = search;
    session.skipped = { already: 0, seen: 0 };
    const answers = await this.rounds(key, search);
    const creditsUsed = answers.reduce((sum, one) => sum + usedBy(one), 0);
    const failures = answers.flatMap(failureOf);
    await this.settle(sealed, { creditsUsed, failures });
    const found = this.waitingOf(search);
    this.deps.log.info(
      { searches: answers.length, results: found.length, creditsUsed },
      'web search',
    );
    if (found.length === 0) assertAnswered(answers, failures);
    // Nobody is there to see them: they wait for the next request, given to no one.
    if (context.signal?.aborted) throw stopped();
    await this.deps.seen.add(
      context,
      found.map((one) => pageKey(one.url)),
    );
    session.waiting.splice(0, found.length);
    return this.answerOf(found, { search, answers, creditsUsed });
  }

  /** What is to be given now: asked again whether it may, for it may have been given since. */
  private waitingOf(search: Search): readonly Candidate[] {
    const { session, request } = search;
    const may = session.waiting.filter((one) => this.mayGive(one, search));
    session.waiting.splice(0, session.waiting.length, ...may);
    return may.slice(0, request.sources);
  }

  private answerOf(
    found: readonly Candidate[],
    of: {
      readonly search: Search;
      readonly answers: readonly GroupAnswer[];
      readonly creditsUsed: number;
    },
  ): WebSearchResponse {
    const { session, context } = of.search;
    return {
      results: found.map((one) => resultOf(one, context.alreadyOf)),
      partial: of.answers.some((one) => one.answer.kind !== 'ok'),
      exhausted: session.exhausted,
      skipped: session.skipped,
      creditsUsed: of.creditsUsed,
      creditsRemaining: this.known.credits?.remaining ?? null,
      low: this.isLow(),
    };
  }

  /** A few searches at a time, while something is missing, there is time and someone waits. */
  private async rounds(key: string, search: Search): Promise<GroupAnswer[]> {
    const { request, context, session } = search;
    const until = this.now().getTime() + ROUNDS_BUDGET_MS;
    const all: GroupAnswer[] = [];
    while (
      session.waiting.length < request.sources &&
      this.now().getTime() < until &&
      !context.signal?.aborted
    ) {
      const groups = session.next(SEARCHES_AT_ONCE);
      if (groups.length === 0) break;
      const answers = await Promise.all(
        groups.map((group) => this.askOne(key, group)),
      );
      all.push(...answers);
      this.take(answers, search);
      if (this.keepForLater(answers, session)) break;
    }
    return all;
  }

  /** What was not answered, for later; whether going on would only be told the same. */
  private keepForLater(
    answers: readonly GroupAnswer[],
    session: SearchSession,
  ): boolean {
    const refused = answers.filter(({ answer }) => STOPS.has(answer.kind));
    session.putBack(refused.map(({ group }) => group));
    for (const { group, answer } of answers)
      if (answer.kind === 'unreachable') session.retryLater(group);
    return refused.length > 0;
  }

  /** What was found that may be given, into the session. */
  private take(answers: readonly GroupAnswer[], search: Search): void {
    const { request, session } = search;
    const found = interleave(
      answers.map((one) => candidatesIn(one, request.query)),
    );
    const given = session
      .unknownOf(found)
      .filter((one) => this.mayGive(one, search));
    session.waiting.push(...given);
  }

  private mayGive(
    one: Candidate,
    { request, context, session }: Search,
  ): boolean {
    if (request.again) return true;
    if (context.alreadyOf(one.url) !== null) {
      session.skipped.already += 1;
      return false;
    }
    if (!this.deps.seen.has(context, pageKey(one.url))) return true;
    session.skipped.seen += 1;
    return false;
  }

  /** One search, unless it was paid for a moment ago. */
  private async askOne(key: string, group: SearchGroup): Promise<GroupAnswer> {
    const kept = this.answers.get(group, this.now().getTime());
    if (kept)
      return { group, answer: { kind: 'ok', hits: kept, creditsUsed: 0 } };
    const { kind, query, domains } = group;
    const answer = await this.deps.web.search({
      key,
      query,
      limit: RESULTS_PER_SEARCH,
      ...(domains && { domains }),
    });
    if (answer.kind === 'ok')
      this.answers.put(group, answer.hits, this.now().getTime());
    else this.warn(kind, answer);
    return { group, answer };
  }

  /** What a search cost and showed about the key it was made with, unless it was replaced. */
  private async settle(
    sealed: string,
    outcome: { creditsUsed: number; failures: readonly WebSearchFailure[] },
  ): Promise<void> {
    if (this.config.connection?.key !== sealed) return;
    const kinds = outcome.failures.map((failure) => failure.kind);
    this.known = {
      ...this.known,
      credits: kinds.includes('no-credits')
        ? { plan: null, periodEnd: null, ...this.known.credits, remaining: 0 }
        : spent(this.known.credits, outcome.creditsUsed),
    };
    if (kinds.includes('key-rejected')) await this.markKey(sealed, true);
  }

  private view(): WebSearchSettings {
    const { connection } = this.config;
    // A key this server can no longer open is as good as none (ADR 0017).
    const connected = this.key() !== null;
    return {
      connected,
      keyHint: connected ? (connection?.last4 ?? null) : null,
      credits: this.known.credits,
      low: this.isLow(),
      checkedAt: this.known.checkedAt,
      problem: connected ? this.problem() : null,
    };
  }

  private problem(): WebSearchSettings['problem'] {
    if (this.config.connection?.keyRejected) return 'key-rejected';
    return this.known.unreachable ? 'unreachable' : null;
  }

  private isLow(): boolean {
    const { credits } = this.known;
    return credits !== null && credits.remaining < WEB_SEARCH_LOW_CREDITS;
  }

  /** The account asked again when its answer is older than `ttlMs`; one call at a time. */
  private refresh(ttlMs: number): Promise<void> {
    const key = this.key();
    const sealed = this.config.connection?.key;
    const fresh = this.now().getTime() - this.known.askedAt < ttlMs;
    if (key === null || sealed === undefined || fresh) return Promise.resolve();
    this.checking ??= this.check(sealed, key).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async check(sealed: string, key: string): Promise<void> {
    const account = await this.deps.web.account(key);
    // Another key was pasted (or this one removed) while Firecrawl answered.
    if (this.config.connection?.key !== sealed) return;
    this.known = this.learned(account);
    if (account.kind === 'ok') await this.markKey(sealed, false);
    else this.warn('account', account);
    if (account.kind === 'key-rejected') await this.markKey(sealed, true);
  }

  /** What is known after the account answered; a failure keeps the last balance. */
  private learned(account: WebSearchAccount): Known {
    const now = this.now();
    if (account.kind === 'ok')
      return {
        credits: account.balance,
        checkedAt: now.toISOString(),
        unreachable: false,
        askedAt: now.getTime(),
      };
    return {
      ...this.known,
      unreachable: account.kind !== 'key-rejected',
      askedAt: now.getTime(),
    };
  }

  private async markKey(sealed: string, keyRejected: boolean): Promise<void> {
    if (this.config.connection?.keyRejected === keyRejected) return;
    await this.change((config) =>
      config.connection?.key === sealed
        ? { ...config, connection: { ...config.connection, keyRejected } }
        : config,
    );
  }

  /** The key a search may use: stored, readable and not refused. */
  private usableKey(): string | null {
    return this.config.connection?.keyRejected ? null : this.key();
  }

  private key(): string | null {
    const sealed = this.config.connection?.key;
    if (!sealed) return null;
    try {
      return this.deps.sealer.open(sealed, KEY_CONTEXT);
    } catch {
      return null;
    }
  }

  private warn(
    asked: SearchGroup['kind'] | 'account',
    failure: WebSearchFailure,
  ): void {
    this.deps.log.warn({ asked, failure }, 'web search: Firecrawl failed');
  }

  /** Changes apply one after the other, each written before the next starts. */
  private change(
    apply: (config: WebSearchConfig) => WebSearchConfig,
  ): Promise<void> {
    const run = this.writing.then(async () => {
      const next = apply(this.config);
      await this.deps.store.write(next);
      this.config = next;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }
}

const failureOf = ({ answer }: GroupAnswer): WebSearchFailure[] =>
  answer.kind === 'ok' ? [] : [answer];

const usedBy = ({ answer }: GroupAnswer): number =>
  answer.kind === 'ok' ? answer.creditsUsed : 0;

const candidatesIn = (
  { group, answer }: GroupAnswer,
  subject: string,
): Candidate[] =>
  answer.kind === 'ok' ? candidatesOf(answer.hits, { ...group, subject }) : [];

const resultOf = (one: Candidate, alreadyOf: AlreadyOf): WebSearchResult => ({
  kind: one.kind,
  url: one.url,
  title: one.title,
  snippet: one.snippet,
  site: one.site,
  author: one.author,
  already: alreadyOf(one.url),
});

/** Nothing found: fine when every search that answered says so, else the reason is thrown. */
function assertAnswered(
  answers: readonly GroupAnswer[],
  failures: readonly WebSearchFailure[],
): void {
  const answered = answers.some((one) => one.answer.kind === 'ok');
  const stopped = failures.filter((failure) => STOPS.has(failure.kind));
  const error = errorOf(answered ? stopped : failures);
  if (error) throw error;
}

const spent = (
  credits: WebSearchCredits | null,
  used: number,
): WebSearchCredits | null =>
  credits && { ...credits, remaining: Math.max(0, credits.remaining - used) };

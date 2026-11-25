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
import {
  RESULTS_PER_SEARCH,
  groupsOf,
  type SearchGroup,
} from './search-plan.js';
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

/** A search of the request and its answer; null when it was not made. */
interface GroupAnswer {
  readonly group: SearchGroup;
  readonly answer: WebSearchAnswer | null;
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
   * collection has and what the person was already given stay out, unless `again` asks.
   * A search that does not answer leaves the others' results (`partial`) and is asked first
   * the next time; with nothing found, why is said instead.
   */
  async search(
    request: WebSearchRequest,
    context: SearchContext,
  ): Promise<WebSearchResponse> {
    const key = this.usableKey();
    const sealed = this.config.connection?.key;
    if (key === null || sealed === undefined) throw notConnected();
    const session = this.sessions.of(context, request, this.now().getTime());
    session.skipped = { already: 0, seen: 0 };
    const answers = await this.rounds(key, { request, context, session });
    const creditsUsed = answers.reduce((sum, one) => sum + usedBy(one), 0);
    const failures = answers.flatMap(failureOf);
    await this.settle(sealed, { creditsUsed, failures });
    const found = session.waiting.splice(0, request.sources);
    this.deps.log.info(
      { searches: answers.length, results: found.length, creditsUsed },
      'web search',
    );
    if (found.length === 0) assertAnswered(answers, failures);
    await this.deps.seen.add(
      context,
      found.map((one) => pageKey(one.url)),
    );
    return this.answerOf(found, { context, session, answers, creditsUsed });
  }

  private answerOf(
    found: readonly Candidate[],
    of: {
      readonly context: SearchContext;
      readonly session: SearchSession;
      readonly answers: readonly GroupAnswer[];
      readonly creditsUsed: number;
    },
  ): WebSearchResponse {
    return {
      results: found.map((one) => resultOf(one, of.context.alreadyOf)),
      partial: of.answers.some((one) => one.answer?.kind !== 'ok'),
      exhausted: of.session.exhausted,
      skipped: of.session.skipped,
      creditsUsed: of.creditsUsed,
      creditsRemaining: this.known.credits?.remaining ?? null,
      low: this.isLow(),
    };
  }

  /** The rounds one answer takes; stops where going on would only be refused. */
  private async rounds(key: string, search: Search): Promise<GroupAnswer[]> {
    const { request, session } = search;
    const until = Date.now() + ROUNDS_BUDGET_MS;
    const all: GroupAnswer[] = [];
    while (session.waiting.length < request.sources && Date.now() < until) {
      const retrying = session.pending.length > 0;
      const groups = nextGroups(request, session);
      if (groups.length === 0) break;
      const answers = await this.ask(key, groups);
      all.push(...answers);
      session.pending = pendingOf(answers, retrying);
      const fresh = this.take(answers, search);
      // A round cut short, or asked again, says nothing of what is left to find.
      if (session.pending.length > 0) break;
      if (!retrying) session.noteRound(fresh);
    }
    return all;
  }

  /** What a round found that may be given, into the session; how much of it there was. */
  private take(
    answers: readonly GroupAnswer[],
    { request, context, session }: Search,
  ): number {
    const found = interleave(
      answers.map((one) => candidatesIn(one, request.query)),
      session.known,
    );
    for (const one of found) session.known.add(pageKey(one.url));
    const given = found.filter((one) =>
      this.mayGive(one, { request, context, session }),
    );
    session.waiting.push(...given);
    return given.length;
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

  /**
   * Every search of a round, a few at once, in its order. After an answer that asking again
   * would only repeat (no key, no credits, wait), the ones left are not made.
   */
  private async ask(
    key: string,
    groups: readonly SearchGroup[],
  ): Promise<GroupAnswer[]> {
    const answers: GroupAnswer[] = groups.map((group) => ({
      group,
      answer: null,
    }));
    const left = groups.map((group, at) => ({ group, at }));
    const worker = async (): Promise<void> => {
      for (let next = left.shift(); next; next = left.shift()) {
        const { group, at } = next;
        const answer = await this.askOne(key, group);
        answers[at] = { group, answer };
        if (STOPS.has(answer.kind)) left.length = 0;
      }
    };
    await Promise.all(Array.from({ length: SEARCHES_AT_ONCE }, worker));
    return answers;
  }

  private async askOne(
    key: string,
    { kind, query, domains }: SearchGroup,
  ): Promise<WebSearchAnswer> {
    const answer = await this.deps.web.search({
      key,
      query,
      limit: RESULTS_PER_SEARCH,
      ...(domains && { domains }),
    });
    if (answer.kind !== 'ok') this.warn(kind, answer);
    return answer;
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
  answer === null || answer.kind === 'ok' ? [] : [answer];

const usedBy = ({ answer }: GroupAnswer): number =>
  answer?.kind === 'ok' ? answer.creditsUsed : 0;

const candidatesIn = (
  { group, answer }: GroupAnswer,
  subject: string,
): Candidate[] =>
  answer?.kind === 'ok' ? candidatesOf(answer.hits, { ...group, subject }) : [];

const resultOf = (one: Candidate, alreadyOf: AlreadyOf): WebSearchResult => ({
  kind: one.kind,
  url: one.url,
  title: one.title,
  snippet: one.snippet,
  site: one.site,
  author: one.author,
  already: alreadyOf(one.url),
});

/** To be asked again: what was not answered, but what did not answer twice. */
const pendingOf = (
  answers: readonly GroupAnswer[],
  retrying: boolean,
): SearchGroup[] =>
  answers
    .filter(({ answer }) =>
      retrying
        ? answer === null || STOPS.has(answer.kind)
        : answer?.kind !== 'ok',
    )
    .map(({ group }) => group);

/** What was not answered first; else the next round, which ends the session when there is none. */
function nextGroups(
  request: WebSearchRequest,
  session: SearchSession,
): readonly SearchGroup[] {
  if (session.pending.length > 0) return session.pending;
  if (session.ended) return [];
  const groups = groupsOf(request, session.round);
  session.round += 1;
  if (groups.length === 0) session.ended = true;
  return groups;
}

/** Nothing found: fine when every search that answered says so, else the reason is thrown. */
function assertAnswered(
  answers: readonly GroupAnswer[],
  failures: readonly WebSearchFailure[],
): void {
  const answered = answers.some((one) => one.answer?.kind === 'ok');
  const stopped = failures.filter((failure) => STOPS.has(failure.kind));
  const error = errorOf(answered ? stopped : failures);
  if (error) throw error;
}

const spent = (
  credits: WebSearchCredits | null,
  used: number,
): WebSearchCredits | null =>
  credits && { ...credits, remaining: Math.max(0, credits.remaining - used) };

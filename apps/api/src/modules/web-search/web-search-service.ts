import {
  WEB_SEARCH_LOW_CREDITS,
  type WebSearchAvailability,
  type WebSearchCredits,
  type WebSearchKind,
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
import { candidatesOf } from './candidates.js';
import { VIDEO_DOMAINS } from './video-page.js';
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

/** Whether the collection already has a link, for the person asking. */
export type AlreadyOf = (url: string) => WebSearchResult['already'];

export interface WebSearchServiceDeps {
  readonly store: DocumentStorePort;
  readonly sealer: SecretSealerPort;
  readonly web: WebSearchPort;
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

interface KindAnswer {
  readonly kind: WebSearchKind;
  readonly answer: WebSearchAnswer;
}

const notConnected = () =>
  new AppError('WEB_SEARCH_NOT_CONNECTED', 'The web search has no usable key');
const unavailable = () =>
  new AppError('WEB_SEARCH_UNAVAILABLE', 'The web search did not answer');

/** What a search that found nothing at all says, the gravest failure first. */
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

function errorOf(failures: readonly WebSearchFailure[]): AppError {
  const [first] = [...failures].sort(
    (a, b) => GRAVEST.indexOf(a.kind) - GRAVEST.indexOf(b.kind),
  );
  if (!first) return unavailable();
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
  private readonly now: () => Date;

  constructor(private readonly deps: WebSearchServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async load(): Promise<void> {
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

  /** One search per kind. Both failing is an error; one failing is said in `failedKinds`. */
  async search(
    request: WebSearchRequest,
    alreadyOf: AlreadyOf,
  ): Promise<WebSearchResponse> {
    const key = this.usableKey();
    const sealed = this.config.connection?.key;
    if (key === null || sealed === undefined) throw notConnected();
    const answers = await Promise.all(
      request.kinds.map((kind) => this.searchKind(key, { kind, request })),
    );
    const creditsUsed = answers.reduce((sum, one) => sum + usedBy(one), 0);
    const failed = answers.flatMap(failureOf);
    await this.settle(sealed, { creditsUsed, failed });
    if (failed.length === answers.length)
      throw errorOf(failed.map((one) => one.failure));
    const results = resultsOf(answers, { limit: request.limit, alreadyOf });
    this.deps.log.info(
      { kinds: request.kinds, results: results.length, creditsUsed },
      'web search',
    );
    return {
      results,
      failedKinds: failed.map((one) => one.kind),
      creditsUsed,
      creditsRemaining: this.known.credits?.remaining ?? null,
      low: this.isLow(),
    };
  }

  private async searchKind(
    key: string,
    input: { kind: WebSearchKind; request: WebSearchRequest },
  ): Promise<KindAnswer> {
    const { kind, request } = input;
    const answer = await this.deps.web.search({
      key,
      query: request.query,
      limit: request.limit,
      ...(kind === 'video' && { domains: VIDEO_DOMAINS }),
    });
    if (answer.kind !== 'ok') this.warn(kind, answer);
    return { kind, answer };
  }

  /** What a search cost and showed about the key it was made with, unless it was replaced. */
  private async settle(
    sealed: string,
    outcome: { creditsUsed: number; failed: readonly KindFailure[] },
  ): Promise<void> {
    if (this.config.connection?.key !== sealed) return;
    const kinds = outcome.failed.map((one) => one.failure.kind);
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
    asked: WebSearchKind | 'account',
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

interface KindFailure {
  readonly kind: WebSearchKind;
  readonly failure: WebSearchFailure;
}

const failureOf = ({ kind, answer }: KindAnswer): KindFailure[] =>
  answer.kind === 'ok' ? [] : [{ kind, failure: answer }];

const usedBy = ({ answer }: KindAnswer): number =>
  answer.kind === 'ok' ? answer.creditsUsed : 0;

const spent = (
  credits: WebSearchCredits | null,
  used: number,
): WebSearchCredits | null =>
  credits && { ...credits, remaining: Math.max(0, credits.remaining - used) };

/** Every kind's candidates, in the order asked, with what the collection already has. */
function resultsOf(
  answers: readonly KindAnswer[],
  input: { limit: number; alreadyOf: AlreadyOf },
): WebSearchResult[] {
  return answers.flatMap(({ kind, answer }) =>
    answer.kind === 'ok'
      ? candidatesOf(answer.hits, { kind, limit: input.limit }).map((one) => ({
          ...one,
          already: input.alreadyOf(one.url),
        }))
      : [],
  );
}

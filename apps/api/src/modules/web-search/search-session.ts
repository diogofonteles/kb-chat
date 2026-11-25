import type { WebSearchRequest } from '@kb-chat/contracts';
import { pageKey, type Candidate } from './candidates.js';
import { groupsOf, type SearchGroup } from './search-plan.js';
import type { Searcher } from './seen-links.js';

/** A search left alone this long is forgotten. */
const SESSION_TTL_MS = 60 * 60_000;
/** Rounds in a row that found no page it did not know before the request is exhausted. */
const DRY_ROUNDS = 2;

/**
 * Where one person's search of one collection is (in memory): the same search again goes on
 * from here, so what was found and not given yet comes first, and it is paid once.
 */
export class SearchSession {
  /** Found, not given yet. */
  readonly waiting: Candidate[] = [];
  skipped = { already: 0, seen: 0 };
  touchedAt = 0;
  private round = 0;
  private ended = false;
  private dry = 0;
  /** Pages of the round under way that this search did not know. */
  private fresh = 0;
  private queue: SearchGroup[] = [];
  private readonly retried = new Set<SearchGroup>();
  /** The pages this search already found, given or left out. */
  private readonly known = new Set<string>();
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly request: Pick<
      WebSearchRequest,
      'query' | 'kinds' | 'authors'
    >,
  ) {}

  get exhausted(): boolean {
    return this.ended && this.queue.length === 0 && this.waiting.length === 0;
  }

  /** One request of a search at a time: two at once would pay the same query twice. */
  oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.turn.then(work);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** The next searches to make, `most` at once; none when there is no other way to ask. */
  next(most: number): SearchGroup[] {
    if (this.queue.length === 0) this.startRound();
    return this.queue.splice(0, most);
  }

  private startRound(): void {
    if (this.ended) return;
    if (this.round > 0) this.dry = this.fresh > 0 ? 0 : this.dry + 1;
    this.fresh = 0;
    this.queue =
      this.dry < DRY_ROUNDS ? groupsOf(this.request, this.round) : [];
    this.round += 1;
    if (this.queue.length === 0) this.ended = true;
  }

  /** Not asked, or refused for now: first again the next time. */
  putBack(groups: readonly SearchGroup[]): void {
    this.queue.unshift(...groups);
  }

  /** It did not answer: asked once more, after the others; then it is let go. */
  retryLater(group: SearchGroup): void {
    if (this.retried.has(group)) return;
    this.retried.add(group);
    this.queue.push(group);
  }

  /** The pages of these that this search did not know, from now on known. */
  unknownOf(found: readonly Candidate[]): readonly Candidate[] {
    const fresh = found.filter((one) => !this.known.has(pageKey(one.url)));
    for (const one of fresh) this.known.add(pageKey(one.url));
    this.fresh += fresh.length;
    return fresh;
  }
}

/** The searches under way, each person's own. */
export class SearchSessions {
  private readonly sessions = new Map<string, SearchSession>();

  of(who: Searcher, request: WebSearchRequest, now: number): SearchSession {
    for (const [key, one] of this.sessions)
      if (now - one.touchedAt > SESSION_TTL_MS) this.sessions.delete(key);
    if (request.search === undefined) return new SearchSession(request);
    const key = keyOf(who, request);
    const session = this.sessions.get(key) ?? new SearchSession(request);
    session.touchedAt = now;
    this.sessions.set(key, session);
    return session;
  }
}

/** The search named, and what it asks: a name alone never reaches what another one asked. */
const keyOf = (who: Searcher, request: WebSearchRequest): string =>
  JSON.stringify([
    who.principal,
    who.topic,
    request.search,
    request.query,
    [...request.kinds].sort(),
    request.authors,
    request.again,
  ]);

import type { WebSearchRequest } from '@kb-chat/contracts';
import { pageKey, type Candidate } from './candidates.js';
import { isKin, telling } from './relevance.js';
import {
  groupsOf,
  hasOwnWords,
  ownWords,
  type SearchGroup,
} from './search-plan.js';
import type { Searcher } from './seen-links.js';

/** A search left alone this long is forgotten. */
const SESSION_TTL_MS = 60 * 60_000;
/** Rounds in a row that found no page it did not know before the request is exhausted. */
const DRY_ROUNDS = 2;
/** A word of a title shorter than this tells little. */
const WORD_CHARS = 5;

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
  /** A search of the round under way was answered. */
  private answered = false;
  /** A search of the request under way was answered. */
  private spoken = false;
  private queue: SearchGroup[] = [];
  private readonly retried = new Set<SearchGroup>();
  /** Silent before, with nothing else heard then. */
  private readonly doubted = new Set<SearchGroup>();
  /** Silent again: kept apart until something is heard, or nothing else is left to ask. */
  private aside: SearchGroup[] = [];
  /** The words of what was found, and how many titles have each. */
  private readonly words = new Map<string, number>();
  private readonly usedWords: string[] = [];
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
    // A round nobody answered says nothing of what is left to find.
    if (this.round > 0 && this.answered)
      this.dry = this.fresh > 0 ? 0 : this.dry + 1;
    this.fresh = 0;
    this.answered = false;
    this.queue =
      this.dry < DRY_ROUNDS
        ? groupsOf(this.request, this.round, this.wordFound())
        : [];
    this.round += 1;
    if (this.queue.length === 0) this.ended = true;
  }

  /**
   * Past the words of each kind: the one most titles found have, not used yet. The plan's own
   * words are used: what was asked for with them has them in its titles.
   */
  private wordFound(): string | null {
    const { kinds, query, authors } = this.request;
    if (hasOwnWords(kinds, this.round)) return null;
    const asked = [
      ...telling([query, ...authors, ...ownWords(kinds)].join(' ')),
      ...this.usedWords,
    ];
    const [best] = [...this.words]
      .filter(([word]) => !asked.some((one) => isKin(one, word)))
      .sort(([, a], [, b]) => b - a);
    if (!best) return null;
    this.usedWords.push(best[0]);
    return best[0];
  }

  private learnWords(found: readonly Candidate[]): void {
    const words = found
      .flatMap(({ title }) => [...new Set(telling(title))])
      .filter((word) => word.length >= WORD_CHARS && !/\d/.test(word));
    for (const word of words)
      this.words.set(word, (this.words.get(word) ?? 0) + 1);
  }

  /** Not asked, or refused for now: first again the next time. */
  putBack(groups: readonly SearchGroup[]): void {
    this.queue.unshift(...groups);
  }

  /**
   * All asked at once were silent: the engine is away, or it never answers these. The first
   * time they are put back and the request stops (true); silent again, they are kept apart
   * and the next ones tell which it is.
   */
  isAway(silent: readonly SearchGroup[]): boolean {
    // One that others' answers showed to be the trouble had its second time: it is let go.
    const open = silent.filter((group) => !this.retried.has(group));
    const fresh = open.filter((group) => !this.doubted.has(group));
    this.aside.push(...open.filter((group) => this.doubted.has(group)));
    for (const group of fresh) this.doubted.add(group);
    this.putBack(fresh);
    return fresh.length > 0;
  }

  /** The engine answers others: what was kept apart is asked once more, then let go. */
  heard(): void {
    this.answered = true;
    this.spoken = true;
    for (const group of this.aside.splice(0)) this.retryLater(group);
  }

  /**
   * The request ends: what was kept apart waits. With nothing else left to ask it is let go,
   * unless nothing was heard at all: then it is the engine that is away, and all is still due.
   */
  rest(): void {
    const apart = this.aside.splice(0);
    const isLast = this.ended && this.queue.length === 0;
    const letGo = isLast && this.spoken;
    this.spoken = false;
    if (letGo || apart.length === 0) return;
    this.putBack(apart);
    this.ended = false;
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
    this.learnWords(fresh);
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

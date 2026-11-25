import type { WebSearchRequest } from '@kb-chat/contracts';
import type { Candidate } from './candidates.js';
import type { SearchGroup } from './search-plan.js';
import type { Searcher } from './seen-links.js';

/** A search left alone this long starts over. */
const SESSION_TTL_MS = 60 * 60_000;
/** Rounds in a row with nothing new before the request is taken as exhausted. */
const DRY_ROUNDS = 2;

/**
 * Where one person's search of one collection is (in memory): the same request again goes on
 * from here, so what was found and not given yet comes first, and it is paid once.
 */
export class SearchSession {
  /** The next round to ask. */
  round = 0;
  /** Searches that were not answered: asked again before anything else. */
  pending: SearchGroup[] = [];
  /** Found, not given yet. */
  readonly waiting: Candidate[] = [];
  /** The pages this search already found, given or left out. */
  readonly known = new Set<string>();
  skipped = { already: 0, seen: 0 };
  ended = false;
  touchedAt = 0;
  private dry = 0;

  noteRound(fresh: number): void {
    this.dry = fresh > 0 ? 0 : this.dry + 1;
    if (this.dry >= DRY_ROUNDS) this.ended = true;
  }

  get exhausted(): boolean {
    return this.ended && this.waiting.length === 0 && this.pending.length === 0;
  }
}

/** The searches under way, by who searches what. */
export class SearchSessions {
  private readonly sessions = new Map<string, SearchSession>();

  of(who: Searcher, request: WebSearchRequest, now: number): SearchSession {
    for (const [key, one] of this.sessions)
      if (now - one.touchedAt > SESSION_TTL_MS) this.sessions.delete(key);
    const key = keyOf(who, request);
    const session = this.sessions.get(key) ?? new SearchSession();
    session.touchedAt = now;
    this.sessions.set(key, session);
    return session;
  }
}

/** The same search, however many sources are wanted of it now. */
const keyOf = (who: Searcher, request: WebSearchRequest): string =>
  JSON.stringify([
    who.principal,
    who.topic,
    request.query.toLowerCase(),
    [...request.kinds].sort(),
    request.authors.map((name) => name.toLowerCase()),
    request.again,
  ]);

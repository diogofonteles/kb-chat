import type { WebHit } from '../../ports/web-search.js';
import type { SearchGroup } from './search-plan.js';

/** What was paid for a moment ago is not paid again: a search changed and asked anew. */
const KEPT_MS = 30 * 60_000;
const KEPT_MOST = 500;

/** The engine's answers of the last half hour, by what was asked (in memory). */
export class AnswerCache {
  private readonly answers = new Map<
    string,
    { readonly hits: readonly WebHit[]; readonly at: number }
  >();

  get(group: SearchGroup, now: number): readonly WebHit[] | null {
    const kept = this.answers.get(keyOf(group));
    return kept && now - kept.at <= KEPT_MS ? kept.hits : null;
  }

  put(group: SearchGroup, hits: readonly WebHit[], now: number): void {
    const key = keyOf(group);
    this.answers.delete(key);
    this.answers.set(key, { hits, at: now });
    // The oldest leave first: a Map keeps the order they came in.
    for (const oldest of this.answers.keys()) {
      if (this.answers.size <= KEPT_MOST) return;
      this.answers.delete(oldest);
    }
  }
}

const keyOf = ({ query, domains }: SearchGroup): string =>
  JSON.stringify([query.toLowerCase(), domains ?? []]);

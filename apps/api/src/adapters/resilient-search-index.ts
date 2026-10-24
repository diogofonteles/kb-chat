import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
  SearchIndexStatus,
} from '../ports/search-index.js';

/** Uses the primary index while it is up and the fallback otherwise (health: degraded). */
export class ResilientSearchIndex implements SearchIndexPort {
  constructor(
    private readonly primary: SearchIndexPort,
    private readonly fallback: SearchIndexPort,
    private readonly onFallback: (err: unknown) => void = () => undefined,
  ) {}

  status(): SearchIndexStatus {
    return this.primary.status() === 'ok' ? 'ok' : 'degraded';
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    if (this.primary.status() !== 'ok') return this.fallback.search(query);
    try {
      return await this.primary.search(query);
    } catch (err) {
      // Logged so a QMD contract change (Q5) is visible, then served by the fallback.
      this.onFallback(err);
      return this.fallback.search(query);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}

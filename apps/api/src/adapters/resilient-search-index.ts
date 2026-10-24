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
  ) {}

  status(): SearchIndexStatus {
    return this.primary.status() === 'ok' ? 'ok' : 'degraded';
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    if (this.primary.status() !== 'ok') return this.fallback.search(query);
    try {
      return await this.primary.search(query);
    } catch {
      return this.fallback.search(query);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}

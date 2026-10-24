import type { SearchMode } from '@kb-chat/contracts';

export interface IndexQuery {
  readonly collection: string;
  readonly q: string;
  readonly mode: SearchMode;
  readonly limit: number;
}

/** A hit as the index reports it; `id` is the topic-relative markdown path. */
export interface IndexHit {
  readonly id: string;
  readonly score: number;
  readonly snippet: string;
}

export type SearchIndexStatus = 'ok' | 'degraded' | 'down';

export interface SearchIndexPort {
  search(query: IndexQuery): Promise<readonly IndexHit[]>;
  status(): SearchIndexStatus;
  close(): Promise<void>;
}

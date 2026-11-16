import type { SearchMode } from '@kb-chat/contracts';

export interface IndexQuery {
  readonly collection: string;
  readonly q: string;
  readonly mode: SearchMode;
  readonly limit: number;
  /**
   * How deep each sub-search of a fused query ranks before the fusion (KBC-120), never less
   * than `limit`: QMD's default is 20 per sub-search and 40 fused, so the best hits of the whole
   * ranking may lie past it. Set for a viewer who sees part of a collection (the whole budget)
   * and for the hybrid mode of whoever sees all of it; absent, the index's own depth.
   */
  readonly depth?: number;
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
  /**
   * A new index file is in place (install-index.sh --hot, KBC-100 FR-5): read it, without
   * failing a search in flight. Absent where there is nothing to reopen.
   */
  reload?(): Promise<void>;
}

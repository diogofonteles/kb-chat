import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  MARK_PLAYED_MAX,
  libraryPageSchema,
  listeningPreferencesSchema,
  markPlayedResultSchema,
  type LibraryFilters,
  type LibraryPage,
  type LibrarySort,
  type ListeningPreferences,
  type ListeningPreferencesUpdate,
  type MarkPlayedResult,
} from '@kb-chat/contracts';
import {
  catchError,
  concatMap,
  from,
  map,
  of,
  reduce,
  takeWhile,
  type Observable,
} from 'rxjs';
import { PREFERENCES_URL } from './listening-api.js';

export const LIBRARY_URL = '/api/v1/media/library';
export const LIBRARY_HOME_URL = `${LIBRARY_URL}/home`;
export const LIBRARY_RECENTS_URL = `${LIBRARY_URL}/recents`;
export const MARK_PLAYED_URL = '/api/v1/media/played';

/** What the library asks for (KBC-051 FR-1): filters, search and order. */
export interface LibraryRequest {
  readonly filters: LibraryFilters;
  readonly query: string;
  readonly sort: LibrarySort;
}

/** What a mark in batches did: what the API applied, and what never reached it. */
export interface MarkOutcome {
  readonly applied: readonly string[];
  readonly unsent: readonly string[];
}

/** The ids in batches the API takes at once (FR-3). */
function batchesOf(ids: readonly string[]): readonly (readonly string[])[] {
  const batches: (readonly string[])[] = [];
  for (let start = 0; start < ids.length; start += MARK_PLAYED_MAX)
    batches.push(ids.slice(start, start + MARK_PLAYED_MAX));
  return batches;
}

/** The first page's URL; chips go as comma-separated lists, empty ones left out. */
export function libraryUrlOf(
  request: LibraryRequest,
  cursor: string | null = null,
): string {
  const { filters } = request;
  const params = new URLSearchParams();
  const lists = {
    state: filters.states,
    author: filters.authors,
  };
  for (const [name, values] of Object.entries(lists))
    if (values.length > 0) params.set(name, values.join(','));
  if (filters.topic) params.set('topic', filters.topic);
  const query = request.query.trim();
  if (query) params.set('q', query);
  params.set('sort', request.sort);
  if (cursor) params.set('cursor', cursor);
  return `${LIBRARY_URL}?${params.toString()}`;
}

/** Writes of the library, and its next pages; the first page and home use httpResource. */
@Injectable({ providedIn: 'root' })
export class LibraryApi {
  private readonly http = inject(HttpClient);

  page(request: LibraryRequest, cursor: string): Observable<LibraryPage> {
    return this.http
      .get(libraryUrlOf(request, cursor))
      .pipe(map((body) => libraryPageSchema.parse(body)));
  }

  markPlayed(
    ids: readonly string[],
    played: boolean,
  ): Observable<MarkPlayedResult> {
    return this.http
      .put(MARK_PLAYED_URL, { ids, played })
      .pipe(map((body) => markPlayedResultSchema.parse(body)));
  }

  /**
   * Any number of ids, one batch after the other. It stops at the first batch that fails
   * and never errors: the outcome says what is left, since the earlier batches stay saved.
   */
  markPlayedInBatches(
    ids: readonly string[],
    played: boolean,
  ): Observable<MarkOutcome> {
    return from(batchesOf(ids)).pipe(
      concatMap((batch) =>
        this.markPlayed(batch, played).pipe(
          map(({ applied }) => ({ batch, applied })),
          catchError(() => of(null)),
        ),
      ),
      takeWhile((sent) => sent !== null),
      reduce<
        { batch: readonly string[]; applied: string[] } | null,
        MarkOutcome
      >(
        (outcome, sent) => ({
          applied: [...outcome.applied, ...(sent?.applied ?? [])],
          unsent: outcome.unsent.slice(sent?.batch.length ?? 0),
        }),
        { applied: [], unsent: ids },
      ),
    );
  }

  clearRecents(): Observable<void> {
    return this.http.delete(LIBRARY_RECENTS_URL).pipe(map(() => undefined));
  }

  /** Only the library's fields: the player's stay as the server has them (FR-5). */
  savePreferences(
    update: ListeningPreferencesUpdate,
  ): Observable<ListeningPreferences> {
    return this.http
      .put(PREFERENCES_URL, update)
      .pipe(map((body) => listeningPreferencesSchema.parse(body)));
  }
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  MARK_PLAYED_MAX,
  libraryPageSchema,
  librarySearchSchema,
  listeningPreferencesSchema,
  markPlayedResultSchema,
  type LibraryFilters,
  type LibraryPage,
  type LibrarySearch,
  type LibrarySort,
  type ListeningPreferences,
  type ListeningPreferencesUpdate,
  type MarkPlayedResult,
  type MediaMark,
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
export const LIBRARY_SEARCH_URL = `${LIBRARY_URL}/search`;
export const LIBRARY_RECENTS_URL = `${LIBRARY_URL}/recents`;
export const MARK_PLAYED_URL = '/api/v1/media/played';

/** What the library asks for (KBC-051 FR-1): filters and order. */
export interface LibraryRequest {
  readonly filters: LibraryFilters;
  readonly sort: LibrarySort;
}

/** What "Buscar na biblioteca" asks for (KBC-096): the words, under the same filters. */
export interface LibrarySearchRequest {
  readonly filters: LibraryFilters;
  readonly query: string;
}

/** What a mark in batches did: what the API applied, and what never reached it. */
export interface MarkOutcome {
  readonly marks: readonly MediaMark[];
  readonly unsent: readonly string[];
}

/** The ids in batches the API takes at once (FR-3). */
function batchesOf(ids: readonly string[]): readonly (readonly string[])[] {
  const batches: (readonly string[])[] = [];
  for (let start = 0; start < ids.length; start += MARK_PLAYED_MAX)
    batches.push(ids.slice(start, start + MARK_PLAYED_MAX));
  return batches;
}

/** The chips as comma-separated lists, empty ones left out. */
function filterParamsOf(filters: LibraryFilters): URLSearchParams {
  const params = new URLSearchParams();
  const lists = {
    state: filters.states,
    author: filters.authors,
  };
  for (const [name, values] of Object.entries(lists))
    if (values.length > 0) params.set(name, values.join(','));
  if (filters.topic) params.set('topic', filters.topic);
  if (filters.subject) params.set('subject', filters.subject);
  return params;
}

/** The first page's URL. */
export function libraryUrlOf(
  request: LibraryRequest,
  cursor: string | null = null,
): string {
  const params = filterParamsOf(request.filters);
  params.set('sort', request.sort);
  if (cursor) params.set('cursor', cursor);
  return `${LIBRARY_URL}?${params.toString()}`;
}

/** A search's URL; the words are asked trimmed. */
export function librarySearchUrlOf(
  request: LibrarySearchRequest,
  cursor: string | null = null,
): string {
  const params = filterParamsOf(request.filters);
  params.set('q', request.query.trim());
  if (cursor) params.set('cursor', cursor);
  return `${LIBRARY_SEARCH_URL}?${params.toString()}`;
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

  search(
    request: LibrarySearchRequest,
    cursor: string,
  ): Observable<LibrarySearch> {
    return this.http
      .get(librarySearchUrlOf(request, cursor))
      .pipe(map((body) => librarySearchSchema.parse(body)));
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
          map(({ marks }) => ({ batch, marks })),
          catchError(() => of(null)),
        ),
      ),
      takeWhile((sent) => sent !== null),
      reduce<
        { batch: readonly string[]; marks: readonly MediaMark[] } | null,
        MarkOutcome
      >(
        (outcome, sent) => ({
          marks: [...outcome.marks, ...(sent?.marks ?? [])],
          unsent: outcome.unsent.slice(sent?.batch.length ?? 0),
        }),
        { marks: [], unsent: ids },
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

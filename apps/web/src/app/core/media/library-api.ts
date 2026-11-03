import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
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
import { map, type Observable } from 'rxjs';
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

/** The first page's URL; chips go as comma-separated lists, empty ones left out. */
export function libraryUrlOf(
  request: LibraryRequest,
  cursor: string | null = null,
): string {
  const { filters } = request;
  const params = new URLSearchParams();
  const lists = {
    state: filters.states,
    authorship: filters.authorships,
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

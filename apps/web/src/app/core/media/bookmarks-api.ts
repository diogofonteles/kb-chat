import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaBookmarkListSchema,
  mediaBookmarkSchema,
  myMediaBookmarkListSchema,
  type CreateMediaBookmarkRequest,
  type MediaBookmark,
  type MyMediaBookmark,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

export const MY_BOOKMARKS_URL = '/api/v1/media/bookmarks';
export const bookmarksUrl = (mediaId: string): string =>
  `${mediaUrl(mediaId)}/bookmarks`;
const bookmarkUrl = (mediaId: string, id: string): string =>
  `${bookmarksUrl(mediaId)}/${encodeURIComponent(id)}`;

/** Each person's bookmarks on the server (KBC-042 FR-1, FR-5). */
@Injectable({ providedIn: 'root' })
export class BookmarksApi {
  private readonly http = inject(HttpClient);

  list(mediaId: string): Observable<MediaBookmark[]> {
    return this.http
      .get(bookmarksUrl(mediaId))
      .pipe(map((body) => mediaBookmarkListSchema.parse(body).items));
  }

  /** Sending the same bookmark again gives it back: a retry never doubles it. */
  create(
    mediaId: string,
    request: CreateMediaBookmarkRequest,
  ): Observable<MediaBookmark> {
    return this.http
      .post(bookmarksUrl(mediaId), request)
      .pipe(map((body) => mediaBookmarkSchema.parse(body)));
  }

  updateNote(
    mediaId: string,
    id: string,
    note: string | null,
  ): Observable<MediaBookmark> {
    return this.http
      .patch(bookmarkUrl(mediaId, id), { note })
      .pipe(map((body) => mediaBookmarkSchema.parse(body)));
  }

  /** `keepalive` lets a deletion outlive the page as it goes away. */
  remove(
    mediaId: string,
    id: string,
    options: { readonly keepalive?: boolean } = {},
  ): Observable<unknown> {
    return this.http.delete(bookmarkUrl(mediaId, id), {
      keepalive: options.keepalive ?? false,
    });
  }

  mine(): Observable<MyMediaBookmark[]> {
    return this.http
      .get(MY_BOOKMARKS_URL)
      .pipe(map((body) => myMediaBookmarkListSchema.parse(body).items));
  }
}

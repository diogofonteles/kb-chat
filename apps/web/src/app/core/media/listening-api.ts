import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaPreferencesSchema,
  mediaProgressSchema,
  type MediaPreferences,
  type MediaProgress,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

export const PREFERENCES_URL = '/api/v1/media/preferences';
const progressUrl = (id: string): string => `${mediaUrl(id)}/progress`;

/** Each person's way of listening on the server (KBC-041 FR-1 to FR-3). */
@Injectable({ providedIn: 'root' })
export class ListeningApi {
  private readonly http = inject(HttpClient);

  preferences(): Observable<MediaPreferences> {
    return this.http
      .get(PREFERENCES_URL)
      .pipe(map((body) => mediaPreferencesSchema.parse(body)));
  }

  savePreferences(preferences: MediaPreferences): Observable<MediaPreferences> {
    return this.http
      .put(PREFERENCES_URL, preferences)
      .pipe(map((body) => mediaPreferencesSchema.parse(body)));
  }

  /**
   * Saves a position that continues the server's save `basedOn` (null: none seen); the
   * answer is what the server keeps, with its time. A 409 means another device saved since.
   */
  saveProgress(
    id: string,
    save: { readonly positionMs: number; readonly basedOn: string | null },
    options: { readonly keepalive?: boolean } = {},
  ): Observable<MediaProgress> {
    return this.http
      .put(
        progressUrl(id),
        { positionMs: Math.floor(save.positionMs), basedOn: save.basedOn },
        // `keepalive` lets the request outlive the page as it goes away (pagehide).
        { keepalive: options.keepalive ?? false },
      )
      .pipe(map((body) => mediaProgressSchema.parse(body)));
  }
}

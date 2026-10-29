import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaPreferencesSchema,
  type MediaPreferences,
} from '@kb-chat/contracts';
import { CSRF } from '@core/auth/auth-interceptor.js';
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

  saveProgress(id: string, positionMs: number): Observable<null> {
    return this.http
      .put(progressUrl(id), { positionMs: Math.floor(positionMs) })
      .pipe(map(() => null));
  }

  /**
   * The last position as the page goes away (`pagehide`): a `keepalive` request outlives
   * the page, which an HttpClient request does not (FR-3).
   */
  saveProgressOnExit(id: string, positionMs: number): void {
    void fetch(progressUrl(id), {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        [CSRF.header]: CSRF.value,
      },
      body: JSON.stringify({ positionMs: Math.floor(positionMs) }),
    }).catch(() => undefined);
  }
}

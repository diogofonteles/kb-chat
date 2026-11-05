import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaProgressSchema,
  playerPreferencesSchema,
  type MediaPreferences,
  type MediaProgress,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

export const PREFERENCES_URL = '/api/v1/media/preferences';
/** Some of the player's choices: the ones that changed, for the account to merge. */
export type PlayerChange = Partial<MediaPreferences>;

const progressUrl = (id: string): string => `${mediaUrl(id)}/progress`;

/** Each person's way of listening on the server (KBC-041 FR-1 to FR-3). */
@Injectable({ providedIn: 'root' })
export class ListeningApi {
  private readonly http = inject(HttpClient);

  /** The player's choices; the library's (KBC-051) are read and saved by the library. */
  preferences(): Observable<MediaPreferences> {
    return this.http
      .get(PREFERENCES_URL)
      .pipe(map((body) => playerPreferencesSchema.parse(body)));
  }

  /** Sends only what changed: the server keeps the rest as it is (KBC-051 FR-5). */
  savePreferences(change: PlayerChange): Observable<MediaPreferences> {
    return this.http
      .put(PREFERENCES_URL, change)
      .pipe(map((body) => playerPreferencesSchema.parse(body)));
  }

  /**
   * Saves a position that continues the server's save `basedOn` (null: none seen); the
   * answer is what the server keeps, with its time. A 409 means another device saved since.
   * `fileVersion`: the cut it was read on, so that an older one is translated (KBC-073 BR-3).
   */
  saveProgress(
    id: string,
    save: {
      readonly positionMs: number;
      readonly basedOn: string | null;
      readonly fileVersion?: number;
    },
    options: { readonly keepalive?: boolean } = {},
  ): Observable<MediaProgress> {
    return this.http
      .put(
        progressUrl(id),
        { ...save, positionMs: Math.floor(save.positionMs) },
        // `keepalive` lets the request outlive the page as it goes away (pagehide).
        { keepalive: options.keepalive ?? false },
      )
      .pipe(map((body) => mediaProgressSchema.parse(body)));
  }
}

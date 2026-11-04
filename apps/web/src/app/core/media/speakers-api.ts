import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { mediaSpeakersSchema, type MediaSpeakers } from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** The voices of one recording, for whoever edits recordings (KBC-064 FR-4). */
export const speakersUrl = (mediaId: string): string =>
  `${mediaUrl(mediaId)}/speakers`;

/** "Separar vozes" (KBC-064 FR-1): queues a separation on the Mac that separates voices. */
@Injectable({ providedIn: 'root' })
export class SpeakersApi {
  private readonly http = inject(HttpClient);

  /** `voices`: how many the person says there are (1 to 10), or null to let the model estimate. */
  diarize(mediaId: string, voices: number | null): Observable<MediaSpeakers> {
    return this.http
      .post(`${mediaUrl(mediaId)}/diarize`, { voices })
      .pipe(map((body) => mediaSpeakersSchema.parse(body)));
  }
}

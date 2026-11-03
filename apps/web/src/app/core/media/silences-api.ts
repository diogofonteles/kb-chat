import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { mediaSilencesSchema, type MediaSilences } from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** A media item's silence map (KBC-044 FR-3), read with the stream's access rules. */
@Injectable({ providedIn: 'root' })
export class SilencesApi {
  private readonly http = inject(HttpClient);

  silences(id: string): Observable<MediaSilences> {
    return this.http
      .get(`${mediaUrl(id)}/silences`)
      .pipe(map((body) => mediaSilencesSchema.parse(body)));
  }
}

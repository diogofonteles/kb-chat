import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  pairedTranscriberSchema,
  type PairedTranscriber,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const transcribersUrl = (): string => '/api/v1/media/transcribers';

/** "Transcritores" (KBC-036 FR-5): masters pair and revoke the Macs that transcribe. */
@Injectable({ providedIn: 'root' })
export class TranscribersApi {
  private readonly http = inject(HttpClient);

  /** The token comes back this one time (BR-1). */
  pair(name: string): Observable<PairedTranscriber> {
    return this.http
      .post(transcribersUrl(), { name })
      .pipe(map((body) => pairedTranscriberSchema.parse(body)));
  }

  revoke(id: string): Observable<void> {
    return this.http
      .delete(`${transcribersUrl()}/${id}`)
      .pipe(map(() => undefined));
  }
}

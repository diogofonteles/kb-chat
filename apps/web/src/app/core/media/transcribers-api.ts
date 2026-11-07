import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  pairedTranscriberSchema,
  publishExistingTracksResultSchema,
  type PublishExistingTracksResult,
  transcriberSchema,
  type PairedTranscriber,
  type Transcriber,
  type UpdateTranscriberRequest,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const transcribersUrl = (): string => '/api/v1/media/transcribers';

/**
 * "Transcritores" (KBC-036 FR-5): masters pair and revoke the Macs that transcribe, and
 * mark which ones separate voices (KBC-064 FR-6).
 */
@Injectable({ providedIn: 'root' })
export class TranscribersApi {
  private readonly http = inject(HttpClient);

  /** The token comes back this one time (BR-1). */
  pair(name: string): Observable<PairedTranscriber> {
    return this.http
      .post(transcribersUrl(), { name })
      .pipe(map((body) => pairedTranscriberSchema.parse(body)));
  }

  /** What it may do: transcribe, separate voices or both (KBC-064 FR-6). */
  setKinds(
    id: string,
    kinds: UpdateTranscriberRequest['kinds'],
  ): Observable<Transcriber> {
    return this.http
      .patch(`${transcribersUrl()}/${id}`, { kinds })
      .pipe(map((body) => transcriberSchema.parse(body)));
  }

  revoke(id: string): Observable<void> {
    return this.http
      .delete(`${transcribersUrl()}/${id}`)
      .pipe(map(() => undefined));
  }
}

/** "Faixas que já existem" (KBC-099): what each collection has to publish into the vault. */
export const trackDocumentsUrl = (): string => '/api/v1/media/track-documents';

/** Queues the published tracks of the chosen collections for the Mac (masters only). */
@Injectable({ providedIn: 'root' })
export class TrackDocumentsApi {
  private readonly http = inject(HttpClient);

  publish(topics: readonly string[]): Observable<PublishExistingTracksResult> {
    return this.http
      .post(`${trackDocumentsUrl()}/publish`, { topics })
      .pipe(map((body) => publishExistingTracksResultSchema.parse(body)));
  }
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  groqSettingsSchema,
  groqTestResultSchema,
  mediaItemSchema,
  type GroqModeRequest,
  type GroqSettings,
  type GroqTestResult,
  type MediaItem,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const groqUrl = (): string => '/api/v1/media/groq';

/**
 * "Groq de reserva" (KBC-037; masters): the key, the mode, the month's media spend and,
 * for the owner, its cap; and "Transcrever com Groq" on one item.
 */
@Injectable({ providedIn: 'root' })
export class GroqApi {
  private readonly http = inject(HttpClient);

  /** A pasted key is kept only when Groq accepts it; with none, the stored one is tested. */
  test(key?: string): Observable<GroqTestResult> {
    return this.http
      .post(`${groqUrl()}/test`, key === undefined ? {} : { key })
      .pipe(map((body) => groqTestResultSchema.parse(body)));
  }

  removeKey(): Observable<GroqSettings> {
    return this.http
      .delete(`${groqUrl()}/key`)
      .pipe(map((body) => groqSettingsSchema.parse(body)));
  }

  setMode(request: GroqModeRequest): Observable<GroqSettings> {
    return this.http
      .put(`${groqUrl()}/mode`, request)
      .pipe(map((body) => groqSettingsSchema.parse(body)));
  }

  /** The owner only (BR-2). */
  setCap(capUsd: number): Observable<GroqSettings> {
    return this.http
      .put('/api/v1/media/spend-cap', { capUsd })
      .pipe(map((body) => groqSettingsSchema.parse(body)));
  }

  /** Sends one item's waiting transcription to Groq. */
  transcribe(mediaId: string): Observable<MediaItem> {
    return this.http
      .post(`/api/v1/media/${mediaId}/transcription/groq`, null)
      .pipe(map((body) => mediaItemSchema.parse(body)));
  }
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  correctionGroupUndoResultSchema,
  correctionHistorySchema,
  occurrencesSchema,
  transcriptCorrectionBatchResultSchema,
  transcriptCorrectionResultSchema,
  type CorrectionGroupUndoResult,
  type CorrectionHistory,
  type Occurrences,
  type TranscriptCorrectionBatchRequest,
  type TranscriptCorrectionBatchResult,
  type TranscriptCorrectionRequest,
  type TranscriptCorrectionResult,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaTranscriptUrl } from './media-api.js';

export const correctionsUrl = (id: string): string =>
  `${mediaTranscriptUrl(id)}/corrections`;

/** What a preview asks: a text, and the track it is opened from. */
export interface OccurrencesAsk {
  readonly text: string;
  readonly window: { readonly fromMs: number; readonly toMs: number } | null;
  readonly scope: 'window' | 'recording';
}

/** Word corrections of a recording's transcript (KBC-093, ADR 0034). */
@Injectable({ providedIn: 'root' })
export class CorrectionsApi {
  private readonly http = inject(HttpClient);

  correct(
    mediaId: string,
    body: TranscriptCorrectionRequest,
  ): Observable<TranscriptCorrectionResult> {
    return this.http
      .post(correctionsUrl(mediaId), body)
      .pipe(map((answer) => transcriptCorrectionResultSchema.parse(answer)));
  }

  undo(
    mediaId: string,
    correctionId: string,
  ): Observable<TranscriptCorrectionResult> {
    return this.http
      .post(
        `${correctionsUrl(mediaId)}/${encodeURIComponent(correctionId)}/undo`,
        null,
      )
      .pipe(map((answer) => transcriptCorrectionResultSchema.parse(answer)));
  }

  history(mediaId: string, cursor = 0): Observable<CorrectionHistory> {
    return this.http
      .get(correctionsUrl(mediaId), { params: { cursor } })
      .pipe(map((answer) => correctionHistorySchema.parse(answer)));
  }

  occurrences(mediaId: string, ask: OccurrencesAsk): Observable<Occurrences> {
    const params: Record<string, string | number> = {
      text: ask.text,
      scope: ask.window ? ask.scope : 'recording',
      ...(ask.window ?? {}),
    };
    return this.http
      .get(`${mediaTranscriptUrl(mediaId)}/occurrences`, { params })
      .pipe(map((answer) => occurrencesSchema.parse(answer)));
  }

  batch(
    mediaId: string,
    body: TranscriptCorrectionBatchRequest,
  ): Observable<TranscriptCorrectionBatchResult> {
    return this.http
      .post(`${correctionsUrl(mediaId)}/batch`, body)
      .pipe(
        map((answer) => transcriptCorrectionBatchResultSchema.parse(answer)),
      );
  }

  undoGroup(
    mediaId: string,
    groupId: string,
  ): Observable<CorrectionGroupUndoResult> {
    return this.http
      .post(
        `${correctionsUrl(mediaId)}/groups/${encodeURIComponent(groupId)}/undo`,
        null,
      )
      .pipe(map((answer) => correctionGroupUndoResultSchema.parse(answer)));
  }
}

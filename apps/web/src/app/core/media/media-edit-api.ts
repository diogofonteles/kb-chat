import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  editApprovedSchema,
  editSavedSchema,
  mediaEditSchema,
  proposalEstimateSchema,
  proposalRunSchema,
  type EditApproved,
  type EditSaved,
  type MediaEdit,
  type ProposalEstimate,
  type ProposalRun,
  type SaveEditRequest,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** The track validation's reads (KBC-066), for `httpResource`. */
export const mediaEditUrl = (id: string): string => `${mediaUrl(id)}/edit`;
export const editWordsUrl = (id: string): string => `${mediaEditUrl(id)}/words`;
export const mediaWaveformUrl = (id: string): string =>
  `${mediaUrl(id)}/waveform`;
export const mediaTracksUrl = (id: string): string => `${mediaUrl(id)}/tracks`;
/** The screen of steps 3 and 4. */
export const editPagePath = (id: string): string =>
  `/midia/${encodeURIComponent(id)}/faixas`;

const versioned = (version: number) => ({
  headers: new HttpHeaders({ 'If-Match': `"${version}"` }),
});

/** Writes to a recording's draft (FR-1, FR-2), each naming the version it read. */
@Injectable({ providedIn: 'root' })
export class MediaEditApi {
  private readonly http = inject(HttpClient);

  /** The cuts given up go back to the queue (KBC-068 FR-1). */
  retryCuts(mediaId: string, version: number): Observable<EditSaved> {
    return this.http
      .post(`${mediaEditUrl(mediaId)}/retry-cuts`, null, versioned(version))
      .pipe(map((answer) => editSavedSchema.parse(answer)));
  }

  read(mediaId: string): Observable<MediaEdit> {
    return this.http
      .get(mediaEditUrl(mediaId))
      .pipe(map((answer) => mediaEditSchema.parse(answer)));
  }

  /** `keepalive`: the request outlives the page (a reload, a closed tab). */
  save(
    mediaId: string,
    input: {
      readonly body: SaveEditRequest;
      readonly version: number;
      readonly keepalive?: boolean;
    },
  ): Observable<EditSaved> {
    return this.http
      .put(mediaEditUrl(mediaId), input.body, {
        ...versioned(input.version),
        keepalive: input.keepalive,
      })
      .pipe(map((answer) => editSavedSchema.parse(answer)));
  }

  approve(mediaId: string, version: number): Observable<EditApproved> {
    return this.http
      .post(`${mediaEditUrl(mediaId)}/approve`, {}, versioned(version))
      .pipe(map((answer) => editApprovedSchema.parse(answer)));
  }

  reopen(mediaId: string, version: number): Observable<EditSaved> {
    return this.http
      .post(`${mediaEditUrl(mediaId)}/reopen`, {}, versioned(version))
      .pipe(map((answer) => editSavedSchema.parse(answer)));
  }

  /** The cost, before anything runs (KBC-067 BR-3). */
  estimate(mediaId: string): Observable<ProposalEstimate> {
    return this.http
      .post(`${mediaEditUrl(mediaId)}/proposals`, { dryRun: true })
      .pipe(map((answer) => proposalEstimateSchema.parse(answer)));
  }

  propose(mediaId: string): Observable<ProposalRun> {
    return this.http
      .post(`${mediaEditUrl(mediaId)}/proposals`, { dryRun: false })
      .pipe(map((answer) => proposalRunSchema.parse(answer)));
  }
}

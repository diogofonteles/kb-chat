import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaItemSchema,
  proposalEstimateSchema,
  trackEditViewSchema,
  trackSuggestionSchema,
  type MediaItem,
  type ProposalEstimate,
  type TrackBoundsRequest,
  type TrackEditView,
  type TrackPatchRequest,
  type TrackSuggestion,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** A track after its approval (KBC-073), for `httpResource`. */
export const trackEditUrl = (id: string): string =>
  `${mediaUrl(id)}/track-edit`;
export const trackImpactUrl = (id: string): string =>
  `${mediaUrl(id)}/track-impact`;
export const trackHistoryUrl = (id: string): string =>
  `${mediaUrl(id)}/history`;
export const archivedTracksUrl = (recordingId: string): string =>
  `${mediaUrl(recordingId)}/archived-tracks`;
export const MOVED_BOOKMARKS_URL = '/api/v1/media/bookmarks/moved';

/** The bounds editor of a track. */
export const trackBoundsPath = (id: string): string =>
  `/midia/${encodeURIComponent(id)}/limites`;

const versioned = (version: number) => ({
  headers: new HttpHeaders({ 'If-Match': `"${version}"` }),
});

/** What changes a track after its approval; writes name the version they read (BR-10). */
@Injectable({ providedIn: 'root' })
export class TrackRevisionsApi {
  private readonly http = inject(HttpClient);

  view(id: string): Observable<TrackEditView> {
    return this.http
      .get(trackEditUrl(id))
      .pipe(map((answer) => trackEditViewSchema.parse(answer)));
  }

  patch(
    track: Pick<TrackEditView, 'mediaId' | 'version'>,
    body: TrackPatchRequest,
  ): Observable<MediaItem> {
    return this.http
      .patch(mediaUrl(track.mediaId), body, versioned(track.version))
      .pipe(map((answer) => mediaItemSchema.parse(answer)));
  }

  moveBounds(
    track: Pick<TrackEditView, 'mediaId' | 'version'>,
    body: TrackBoundsRequest,
  ): Observable<TrackEditView> {
    return this.http
      .put(`${mediaUrl(track.mediaId)}/bounds`, body, versioned(track.version))
      .pipe(map((answer) => trackEditViewSchema.parse(answer)));
  }

  retryCut(
    track: Pick<TrackEditView, 'mediaId' | 'version'>,
  ): Observable<TrackEditView> {
    return this.http
      .post(
        `${mediaUrl(track.mediaId)}/bounds/retry`,
        null,
        versioned(track.version),
      )
      .pipe(map((answer) => trackEditViewSchema.parse(answer)));
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(mediaUrl(id));
  }

  restore(id: string): Observable<MediaItem> {
    return this.http
      .post(`${mediaUrl(id)}/restore`, null)
      .pipe(map((answer) => mediaItemSchema.parse(answer)));
  }

  /** The cost, said before anything is spent (BR-9). */
  estimate(id: string): Observable<ProposalEstimate> {
    return this.http
      .post(`${mediaUrl(id)}/suggestions`, { dryRun: true })
      .pipe(map((answer) => proposalEstimateSchema.parse(answer)));
  }

  suggest(id: string): Observable<TrackSuggestion> {
    return this.http
      .post(`${mediaUrl(id)}/suggestions`, { dryRun: false })
      .pipe(map((answer) => trackSuggestionSchema.parse(answer)));
  }

  acknowledgeMoved(trackId: string): Observable<unknown> {
    return this.http.post(`${MOVED_BOOKMARKS_URL}/seen`, { mediaId: trackId });
  }
}

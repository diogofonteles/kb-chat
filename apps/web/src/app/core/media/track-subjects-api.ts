import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  freeSubjectSchema,
  subjectEstimateSchema,
  subjectRunSchema,
  trackSubjectsSchema,
  type DecideSuggestionsRequest,
  type FreeSubject,
  type ProposalEstimate,
  type SaveTrackSubjectsRequest,
  type SubjectRun,
  type TrackSubjects,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** What a collection's tracks can link to (KBC-069 FR-1), for `httpResource`. */
export const collectionSubjectsUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/subjects`;
/** Step 4 of a recording. */
export const editSubjectsUrl = (id: string): string =>
  `${mediaUrl(id)}/edit/subjects`;
/** One track, on its own page. */
export const trackSubjectsUrl = (id: string): string =>
  `${mediaUrl(id)}/subjects`;

const versioned = (version: number) => ({
  headers: new HttpHeaders({ 'If-Match': `"${version}"` }),
});

/** Writes to a track's subjects, each naming the version it read, and the AI's suggestion. */
@Injectable({ providedIn: 'root' })
export class TrackSubjectsApi {
  private readonly http = inject(HttpClient);

  createFree(topic: string, name: string): Observable<FreeSubject> {
    return this.http
      .post(collectionSubjectsUrl(topic), { name })
      .pipe(map((answer) => freeSubjectSchema.parse(answer)));
  }

  save(
    track: Pick<TrackSubjects, 'mediaId' | 'version'>,
    body: SaveTrackSubjectsRequest,
  ): Observable<TrackSubjects> {
    return this.http
      .put(trackSubjectsUrl(track.mediaId), body, versioned(track.version))
      .pipe(map((answer) => trackSubjectsSchema.parse(answer)));
  }

  decide(
    track: Pick<TrackSubjects, 'mediaId' | 'version'>,
    body: DecideSuggestionsRequest,
  ): Observable<TrackSubjects> {
    return this.http
      .post(
        `${trackSubjectsUrl(track.mediaId)}/decisions`,
        body,
        versioned(track.version),
      )
      .pipe(map((answer) => trackSubjectsSchema.parse(answer)));
  }

  estimate(mediaId: string): Observable<ProposalEstimate> {
    return this.http
      .post(`${mediaUrl(mediaId)}/edit/subject-proposals`, { dryRun: true })
      .pipe(map((answer) => subjectEstimateSchema.parse(answer)));
  }

  start(mediaId: string): Observable<SubjectRun> {
    return this.http
      .post(`${mediaUrl(mediaId)}/edit/subject-proposals`, { dryRun: false })
      .pipe(map((answer) => subjectRunSchema.parse(answer)));
  }
}

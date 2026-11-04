import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  collectionSpeakerSchema,
  mediaSpeakersSchema,
  type CollectionSpeaker,
  type CollectionSpeakerCreate,
  type CollectionSpeakerUpdate,
  type MediaSpeakers,
  type MergeVoicesRequest,
  type NameVoiceRequest,
  type SplitVoiceRequest,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** The voices of one recording, for whoever edits recordings (KBC-064 FR-4). */
export const speakersUrl = (mediaId: string): string =>
  `${mediaUrl(mediaId)}/speakers`;

/** The speakers of a collection (KBC-065); a sub-collection answers with its parent's. */
export const collectionSpeakersUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/speakers`;

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

  /** Who a voice is (KBC-065 FR-2). */
  nameVoice(
    mediaId: string,
    voice: number,
    body: NameVoiceRequest,
  ): Observable<MediaSpeakers> {
    return this.http
      .put(`${mediaUrl(mediaId)}/voices/${voice}`, body)
      .pipe(map((answer) => mediaSpeakersSchema.parse(answer)));
  }

  mergeVoices(
    mediaId: string,
    body: MergeVoicesRequest,
  ): Observable<MediaSpeakers> {
    return this.voicesAction(mediaId, 'merge', body);
  }

  splitVoice(
    mediaId: string,
    body: SplitVoiceRequest,
  ): Observable<MediaSpeakers> {
    return this.voicesAction(mediaId, 'split', body);
  }

  /** "Confirmar nomes" (FR-5). */
  confirmNames(mediaId: string, version: number): Observable<MediaSpeakers> {
    return this.voicesAction(mediaId, 'confirm', { version });
  }

  /** The new speaker, or the one the name or author already is. */
  createSpeaker(
    topic: string,
    body: CollectionSpeakerCreate,
  ): Observable<CollectionSpeaker> {
    return this.http
      .post(collectionSpeakersUrl(topic), body)
      .pipe(map((answer) => collectionSpeakerSchema.parse(answer)));
  }

  updateSpeaker(
    topic: string,
    id: string,
    body: CollectionSpeakerUpdate,
  ): Observable<CollectionSpeaker> {
    return this.http
      .patch(`${collectionSpeakersUrl(topic)}/${id}`, body)
      .pipe(map((answer) => collectionSpeakerSchema.parse(answer)));
  }

  private voicesAction(
    mediaId: string,
    action: 'merge' | 'split' | 'confirm',
    body: object,
  ): Observable<MediaSpeakers> {
    return this.http
      .post(`${mediaUrl(mediaId)}/voices/${action}`, body)
      .pipe(map((answer) => mediaSpeakersSchema.parse(answer)));
  }
}

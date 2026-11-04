import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  voiceProfileSchema,
  type CreateVoiceProfileRequest,
  type VoiceProfile,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const voiceProfilesUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/voice-profiles`;
export const namedVoicesUrl = (topic: string, speakerId: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/speakers/${speakerId}/named-voices`;
export const voiceReportUrl = (): string => '/api/v1/voice-profiles/report';
export const consentEvidenceUrl = (consentId: string): string =>
  `/api/v1/voice-consents/${consentId}/evidence`;

/** "Perfis de voz" (KBC-071): nothing here carries a voice print (BR-5). */
@Injectable({ providedIn: 'root' })
export class VoiceProfilesApi {
  private readonly http = inject(HttpClient);

  create(
    topic: string,
    body: CreateVoiceProfileRequest,
  ): Observable<VoiceProfile> {
    return this.http
      .post(voiceProfilesUrl(topic), body)
      .pipe(map((answer) => voiceProfileSchema.parse(answer)));
  }

  recalculate(id: string): Observable<VoiceProfile> {
    return this.http
      .post(`/api/v1/voice-profiles/${id}/recalculate`, {})
      .pipe(map((answer) => voiceProfileSchema.parse(answer)));
  }

  /** Revokes the consent: the profile and its print go at once (BR-2). */
  revoke(id: string): Observable<void> {
    return this.http
      .delete(`/api/v1/voice-profiles/${id}`)
      .pipe(map(() => undefined));
  }
}

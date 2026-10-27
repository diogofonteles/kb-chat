import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  inviteProfileListSchema,
  inviteProfileSchema,
  type InviteProfile,
  type InviteProfileCreate,
  type InviteProfileUpdate,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const inviteProfilesUrl = (): string => '/api/v1/invite-profiles';
export const inviteProfileUrl = (id: string): string =>
  `${inviteProfilesUrl()}/${encodeURIComponent(id)}`;

/** "Perfis de convite" (KBC-028 FR-2): masters only. */
@Injectable({ providedIn: 'root' })
export class InviteProfilesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<InviteProfile[]> {
    return this.http
      .get(inviteProfilesUrl())
      .pipe(map((body) => inviteProfileListSchema.parse(body).items));
  }

  create(profile: InviteProfileCreate): Observable<InviteProfile> {
    return this.http
      .post(inviteProfilesUrl(), profile)
      .pipe(map((body) => inviteProfileSchema.parse(body)));
  }

  update(id: string, patch: InviteProfileUpdate): Observable<InviteProfile> {
    return this.http
      .put(inviteProfileUrl(id), patch)
      .pipe(map((body) => inviteProfileSchema.parse(body)));
  }

  remove(id: string): Observable<void> {
    return this.http.delete(inviteProfileUrl(id)).pipe(map(() => undefined));
  }
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  inviteProfileListSchema,
  inviteProfileViewSchema,
  type InviteProfileView,
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

  list(): Observable<InviteProfileView[]> {
    return this.http
      .get(inviteProfilesUrl())
      .pipe(map((body) => inviteProfileListSchema.parse(body).items));
  }

  create(profile: InviteProfileCreate): Observable<InviteProfileView> {
    return this.http
      .post(inviteProfilesUrl(), profile)
      .pipe(map((body) => inviteProfileViewSchema.parse(body)));
  }

  update(
    id: string,
    patch: InviteProfileUpdate,
  ): Observable<InviteProfileView> {
    return this.http
      .put(inviteProfileUrl(id), patch)
      .pipe(map((body) => inviteProfileViewSchema.parse(body)));
  }

  remove(id: string): Observable<void> {
    return this.http.delete(inviteProfileUrl(id)).pipe(map(() => undefined));
  }
}

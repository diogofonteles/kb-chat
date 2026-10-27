import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  authConfigSchema,
  meSchema,
  personListSchema,
  personSchema,
  spendByPersonSchema,
  type AuthConfig,
  type InvitePresetInput,
  type Me,
  type Person,
  type PersonUpdate,
  type SpendByPerson,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const meUrl = (): string => '/api/v1/me';
export const authConfigUrl = (): string => '/api/v1/auth/config';
export const googleLoginUrl = (): string => '/api/v1/auth/google';
export const logoutUrl = (): string => '/api/v1/auth/logout';
export const peopleUrl = (): string => '/api/v1/people';
export const personUrl = (id: string): string =>
  `${peopleUrl()}/${encodeURIComponent(id)}`;

/** Sign-in with Google and who is signed in (KBC-010, ADR 0008). */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);

  config(): Observable<AuthConfig> {
    return this.http
      .get(authConfigUrl())
      .pipe(map((body) => authConfigSchema.parse(body)));
  }

  me(): Observable<Me> {
    return this.http.get(meUrl()).pipe(map((body) => meSchema.parse(body)));
  }

  /** Trades a one-time code for the session cookie (KBC-014). */
  verifyCode(identifier: string, code: string): Observable<Me> {
    return this.http
      .post('/api/v1/auth/code/verify', { identifier, code })
      .pipe(map((body) => meSchema.parse(body)));
  }

  /** Trades Google's ID token for the session cookie. */
  signIn(credential: string): Observable<Me> {
    return this.http
      .post(googleLoginUrl(), { credential })
      .pipe(map((body) => meSchema.parse(body)));
  }

  signOut(): Observable<void> {
    return this.http.post(logoutUrl(), null).pipe(map(() => undefined));
  }
}

/** How an invitation sets the person up (KBC-028): a preset of its own or a profile. */
export type InviteSetup =
  | { readonly preset?: InvitePresetInput; readonly profileId?: never }
  | { readonly profileId?: string; readonly preset?: never };

/** "Pessoas e permissões" (FR-3): masters only. */
@Injectable({ providedIn: 'root' })
export class PeopleApi {
  private readonly http = inject(HttpClient);

  list(): Observable<Person[]> {
    return this.http
      .get(peopleUrl())
      .pipe(map((body) => personListSchema.parse(body).items));
  }

  /**
   * KBC-026: `sendEmail` false is "Não enviar e-mail de convite". KBC-028: a preset or a
   * profile sets the person up; neither means the default profile, if there is one.
   */
  invite(
    email: string,
    sendEmail: boolean,
    setup: InviteSetup = {},
  ): Observable<Person> {
    return this.http
      .post(peopleUrl(), { email, sendEmail, ...setup })
      .pipe(map((body) => personSchema.parse(body)));
  }

  /** "Aplicar perfil" (KBC-028 FR-4) to someone already invited. */
  applyProfile(id: string, profileId: string): Observable<Person> {
    return this.http
      .post(`${personUrl(id)}/profile`, { profileId })
      .pipe(map((body) => personSchema.parse(body)));
  }

  /** "Reenviar convite" (KBC-026): 429 with `retryAt` when limited. */
  resendInvitation(id: string): Observable<Person> {
    return this.http
      .post(`${personUrl(id)}/invitation`, null)
      .pipe(map((body) => personSchema.parse(body)));
  }

  update(id: string, patch: PersonUpdate): Observable<Person> {
    return this.http
      .patch(personUrl(id), patch)
      .pipe(map((body) => personSchema.parse(body)));
  }

  revoke(id: string): Observable<void> {
    return this.http.delete(personUrl(id)).pipe(map(() => undefined));
  }

  /** The owner only (BR-6): today's AI spend of each person, never their content. */
  spendByPerson(): Observable<SpendByPerson> {
    return this.http
      .get('/api/v1/spend/people')
      .pipe(map((body) => spendByPersonSchema.parse(body)));
  }
}

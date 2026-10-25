import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  accessRequestListSchema,
  personSchema,
  type AccessRequest,
  type CodeRequest,
  type GoogleAccessRequest,
  type Person,
  type SignUpRequest,
  type SignUpVerify,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const accessRequestsUrl = (): string => '/api/v1/access-requests';
const decisionUrl = (id: string, decision: 'approve' | 'refuse'): string =>
  `${accessRequestsUrl()}/${encodeURIComponent(id)}/${decision}`;

const done = map(() => undefined);

/** Asking for access and signing in with a one-time code (KBC-014, ADR 0011). */
@Injectable({ providedIn: 'root' })
export class AccessApi {
  private readonly http = inject(HttpClient);

  /** Always 202 (BR-3): a code goes out only when the email can be used. */
  signUp(form: SignUpRequest): Observable<void> {
    return this.http.post(`${accessRequestsUrl()}/signup`, form).pipe(done);
  }

  confirmSignUp(confirmation: SignUpVerify): Observable<void> {
    return this.http
      .post(`${accessRequestsUrl()}/signup/verify`, confirmation)
      .pipe(done);
  }

  /** A not-invited Google account asks for access with its ticket. */
  requestWithGoogle(request: GoogleAccessRequest): Observable<void> {
    return this.http.post(`${accessRequestsUrl()}/google`, request).pipe(done);
  }

  /** Always 202: a code goes out only to a person with access. */
  requestCode(request: CodeRequest): Observable<void> {
    return this.http.post('/api/v1/auth/code', request).pipe(done);
  }
}

/** "Solicitações pendentes" (KBC-014 FR-4): masters only. */
@Injectable({ providedIn: 'root' })
export class AccessRequestsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<AccessRequest[]> {
    return this.http
      .get(accessRequestsUrl())
      .pipe(map((body) => accessRequestListSchema.parse(body).items));
  }

  approve(id: string): Observable<Person> {
    return this.http
      .post(decisionUrl(id, 'approve'), null)
      .pipe(map((body) => personSchema.parse(body)));
  }

  refuse(id: string): Observable<void> {
    return this.http.post(decisionUrl(id, 'refuse'), null).pipe(done);
  }
}

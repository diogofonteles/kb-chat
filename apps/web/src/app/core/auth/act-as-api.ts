import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  actAsAuditListSchema,
  actingSchema,
  myAccessListSchema,
  type ActAsAuditEntry,
  type Acting,
  type MyAccess,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { personUrl } from './auth-api.js';

export const ACT_AS_URL = '/api/v1/act-as';
export const ACT_AS_AUDIT_URL = '/api/v1/act-as/audit';
export const MY_ACCESSES_URL = '/api/v1/me/accesses';

/**
 * Starting or ending acting as a person reloads the app at its home page: nothing of one
 * view (lists, settings, players) is left on screen in the other (ADR 0027).
 */
export const RESTART_APP = new InjectionToken<() => void>('RESTART_APP', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return () => {
      // The master's other tabs change view too: none keeps writing as the other one.
      announceViewChange();
      view?.location.assign('/');
    };
  },
});

/** The channel the app's tabs hear a change of view on (KBC-060). */
export const VIEW_CHANNEL = 'kb-chat.view';

function announceViewChange(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(VIEW_CHANNEL);
  channel.postMessage('changed');
  channel.close();
}

/** A master acting as a person (KBC-060): start, end, the audit and one's own accesses. */
@Injectable({ providedIn: 'root' })
export class ActAsApi {
  private readonly http = inject(HttpClient);

  start(personId: string, reason: string): Observable<Acting> {
    return this.http
      .post(`${personUrl(personId)}/act-as`, { reason })
      .pipe(map((body) => actingSchema.parse(body)));
  }

  stop(): Observable<void> {
    return this.http.delete(ACT_AS_URL).pipe(map(() => undefined));
  }

  audit(): Observable<ActAsAuditEntry[]> {
    return this.http
      .get(ACT_AS_AUDIT_URL)
      .pipe(map((body) => actAsAuditListSchema.parse(body).items));
  }

  accesses(): Observable<MyAccess[]> {
    return this.http
      .get(MY_ACCESSES_URL)
      .pipe(map((body) => myAccessListSchema.parse(body).items));
  }
}

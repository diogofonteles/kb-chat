import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * What the HTTP layer tells the session (a 401 anywhere). Kept apart from SessionStore so
 * the interceptor, part of the first bundle, does not pull the contracts in with it.
 */
@Injectable({ providedIn: 'root' })
export class SessionEvents {
  readonly expired$ = new Subject<void>();
}

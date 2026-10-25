import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AccessRequest, Person } from '@kb-chat/contracts';
import { EMPTY, fromEvent, tap, type Observable } from 'rxjs';
import { AccessRequestsApi } from './access-api.js';
import { SessionStore } from './session-store.js';

/**
 * The pending access requests a master decides on (KBC-014): the sidebar's count and the
 * list in "Pessoas e permissões" read the same state.
 */
@Injectable({ providedIn: 'root' })
export class AccessRequestsStore {
  private readonly api = inject(AccessRequestsApi);
  private readonly session = inject(SessionStore);

  readonly requests = rxResource({
    params: () => this.session.isMaster() || undefined,
    stream: () => this.api.list(),
  });
  readonly list = computed<readonly AccessRequest[]>(() =>
    this.requests.hasValue() ? this.requests.value() : [],
  );
  readonly count = computed(() => this.list().length);

  constructor() {
    // A master who comes back to the tab sees requests made meanwhile (the sidebar badge).
    const view = inject(DOCUMENT).defaultView;
    (view ? fromEvent(view, 'focus') : EMPTY)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.reload());
  }

  /** Fetches again once loaded or failed (the first load runs by itself for a master). */
  reload(): void {
    if (this.requests.hasValue() || this.requests.error())
      this.requests.reload();
  }

  approve(id: string): Observable<Person> {
    return this.api.approve(id).pipe(tap(() => this.drop(id)));
  }

  refuse(id: string): Observable<void> {
    return this.api.refuse(id).pipe(tap(() => this.drop(id)));
  }

  private drop(id: string): void {
    this.requests.update((items) => (items ?? []).filter((r) => r.id !== id));
  }
}

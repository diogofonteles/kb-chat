import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { UsageEvent } from '@kb-chat/contracts';

/**
 * Local usage log (KBC-006 FR-3): fire-and-forget POSTs to this computer's API.
 * A failure is ignored; measuring never gets in the reader's way.
 */
@Injectable({ providedIn: 'root' })
export class UsageLog {
  private readonly http = inject(HttpClient);
  /** One session per page load. */
  readonly sessionId = crypto.randomUUID();

  track(event: UsageEvent): void {
    this.http
      .post('/api/v1/events', { sessionId: this.sessionId, event })
      .subscribe({ error: () => undefined });
  }
}

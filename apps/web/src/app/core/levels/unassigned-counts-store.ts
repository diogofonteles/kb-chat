import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
import { unassignedCountsSchema } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { unassignedCountsUrl } from './levels-api.js';

/**
 * "N documentos sem nível" per collection (KBC-107 FR-6), for masters and whoever classifies
 * content; nothing is asked for anyone else. Reloaded after a level is given.
 */
@Injectable({ providedIn: 'root' })
export class UnassignedCountsStore {
  private readonly session = inject(SessionStore);
  private readonly counts = httpResource(
    () =>
      this.session.me()?.features.includes('content-levels')
        ? unassignedCountsUrl()
        : undefined,
    { parse: (body) => unassignedCountsSchema.parse(body) },
  );
  private readonly byCollection = computed(
    () =>
      new Map(
        (this.counts.hasValue() ? this.counts.value().items : []).map(
          (one) => [one.collection, one.unassigned] as const,
        ),
      ),
  );

  /** The documents without a level of a top-level collection; 0 when none or unknown. */
  countOf(collection: string): number {
    return this.byCollection().get(collection) ?? 0;
  }

  refresh(): void {
    this.counts.reload();
  }
}

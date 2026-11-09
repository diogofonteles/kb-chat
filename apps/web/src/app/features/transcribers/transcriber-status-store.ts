import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject, DestroyRef } from '@angular/core';
import {
  transcriberStatusOverviewSchema,
  type TranscriberStatusItem,
  type TranscriberStatusOverview,
} from '@kb-chat/contracts';
import { transcriberStatusUrl } from '@core/media/transcribers-api.js';

/** The transcriber says what it does every 30 s: read it as often (KBC-114 FR-8). */
export const STATUS_REFRESH_MS = 30_000;

type State = TranscriberStatusItem['state'];

/** Which state the summary chip shows when there are several: the most telling one. */
const RANK: Record<State, number> = {
  working: 0,
  waiting: 1,
  error: 2,
  idle: 3,
  offline: 4,
};

/**
 * The transcribers' status, read once for the whole page (the chip in the collection and
 * each row of Transcritores share it) and again every 30 s while someone shows it.
 */
@Injectable()
export class TranscriberStatusStore {
  private readonly resource = httpResource(() => transcriberStatusUrl(), {
    parse: (body) => transcriberStatusOverviewSchema.parse(body),
  });
  private readonly last = computed<TranscriberStatusOverview | null>(() =>
    this.resource.hasValue() ? this.resource.value() : null,
  );

  readonly overview = this.last;
  readonly failed = computed(() => this.resource.error() !== undefined);
  readonly items = computed(() => this.last()?.items ?? []);
  /** The one the summary speaks for: publishers first (they turn transcriptions into documents). */
  readonly lead = computed<TranscriberStatusItem | null>(() => {
    const items = this.items();
    const publishers = items.filter((one) => one.kinds.includes('kb-publish'));
    const pool = publishers.length > 0 ? publishers : items;
    return [...pool].sort((a, b) => RANK[a.state] - RANK[b.state])[0] ?? null;
  });

  constructor() {
    const timer = setInterval(() => this.resource.reload(), STATUS_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  item(id: string): TranscriberStatusItem | null {
    return this.items().find((one) => one.id === id) ?? null;
  }

  reload(): void {
    this.resource.reload();
  }
}

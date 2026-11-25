import { httpResource } from '@angular/common/http';
import { Injectable, computed } from '@angular/core';
import {
  CONTENT_COST_KINDS,
  contentCostsSchema,
  type ContentCosts,
} from '@kb-chat/contracts';
import { contentCostsUrl } from '@core/documents/document-uploads-api.js';

/** How many of each kind the person is about to send. */
export interface ContentCounts {
  readonly document: number;
  readonly image: number;
  readonly page: number;
  readonly recording: number;
  /** Channels and playlists: what is chosen from them is another inclusion. */
  readonly list: number;
}

export const NO_CONTENT: ContentCounts = {
  document: 0,
  image: 0,
  page: 0,
  recording: 0,
  list: 0,
};

/** Used until the API answers: the first measurements it starts from. */
const BEFORE_ANSWER: ContentCosts = {
  document: { usd: 0.003, seconds: 60, samples: 0 },
  image: { usd: 0.004, seconds: 40, samples: 0 },
  page: { usd: 0.003, seconds: 40, samples: 0 },
  recording: { usd: 0.003, seconds: 60, samples: 0 },
};

/** What each kind took here (KBC-186), read once by the page. */
@Injectable()
export class ContentCostsStore {
  private readonly answer = httpResource(() => contentCostsUrl(), {
    parse: (body) => contentCostsSchema.parse(body),
  });
  readonly costs = computed<ContentCosts>(() =>
    this.answer.hasValue() ? this.answer.value() : BEFORE_ANSWER,
  );

  /** "Até": what most of the same kind cost here, times how many. */
  usd(counts: ContentCounts): number {
    const costs = this.costs();
    return CONTENT_COST_KINDS.reduce(
      (sum, kind) => sum + counts[kind] * costs[kind].usd,
      0,
    );
  }

  /** The Mac's time, one after the other. */
  seconds(counts: ContentCounts): number {
    const costs = this.costs();
    return CONTENT_COST_KINDS.reduce(
      (sum, kind) => sum + counts[kind] * costs[kind].seconds,
      0,
    );
  }
}

import type { ContentCosts, DocumentWork } from '@kb-chat/contracts';
import type { DocumentUploadRecord } from '../../ports/document-uploads.js';
import { costKindOf } from './content-costs.js';
import { isWorking } from './upload-batches.js';

/** Reading a channel or a playlist is one short command. */
const LIST_SECONDS = 20;

/** An item's place in the Mac's line, or how long it has been at it. */
export interface PlaceInLine {
  readonly startedAt: string | null;
  readonly position: number | null;
  readonly startsInSeconds: number | null;
  readonly takesSeconds: number | null;
}

const NOWHERE: PlaceInLine = {
  startedAt: null,
  position: null,
  startsInSeconds: null,
  takesSeconds: null,
};

/** The Mac takes the oldest first. */
export const inLineOrder = (
  a: DocumentUploadRecord,
  b: DocumentUploadRecord,
): number => a.createdAt.localeCompare(b.createdAt);

/**
 * The Mac's line at one moment (KBC-184), read once over every item, whoever sent it: one item
 * at a time, the oldest first. It says places and times, never another person's item.
 */
export class MacLine {
  private readonly places = new Map<string, PlaceInLine>();
  readonly busy: boolean;
  readonly waiting: number;

  constructor(
    records: readonly DocumentUploadRecord[],
    private readonly input: {
      readonly now: Date;
      readonly costs: ContentCosts;
      readonly mac: DocumentWork['mac']['state'];
      /** Waiting for the Mac, and not for a ceiling. */
      readonly isWaiting: (record: DocumentUploadRecord) => boolean;
    },
  ) {
    const working = records.filter((one) => isWorking(one, input.now));
    const waiting = records.filter(input.isWaiting).sort(inLineOrder);
    this.busy = working.length > 0;
    this.waiting = waiting.length;
    const ahead = working.reduce((sum, one) => sum + this.placeWorking(one), 0);
    this.placeWaiting(waiting, ahead);
  }

  /** The Mac has it: since when, and what is left; answers what is left. */
  private placeWorking(record: DocumentUploadRecord): number {
    const left = this.leftOf(record);
    this.places.set(record.id, {
      ...NOWHERE,
      startedAt: record.lease?.since || null,
      takesSeconds: left,
    });
    return left;
  }

  private placeWaiting(
    waiting: readonly DocumentUploadRecord[],
    ahead: number,
  ): void {
    // Nobody knows when a Mac that is off comes back.
    const known = this.busy || this.input.mac === 'on';
    let before = ahead;
    for (const [at, record] of waiting.entries()) {
      const takesSeconds = this.secondsOf(record);
      this.places.set(record.id, {
        startedAt: null,
        position: at + 1,
        startsInSeconds: known ? before : null,
        takesSeconds,
      });
      before += takesSeconds;
    }
  }

  placeOf(id: string): PlaceInLine {
    return this.places.get(id) ?? NOWHERE;
  }

  private secondsOf(record: DocumentUploadRecord): number {
    const kind = costKindOf(record);
    return kind === null
      ? LIST_SECONDS
      : Math.ceil(this.input.costs[kind].seconds);
  }

  /** What one like it takes, less what it already took. */
  private leftOf(record: DocumentUploadRecord): number {
    const since = Date.parse(record.lease?.since ?? '');
    const takes = this.secondsOf(record);
    if (Number.isNaN(since)) return takes;
    const spent = (this.input.now.getTime() - since) / 1_000;
    return Math.max(0, Math.round(takes - spent));
  }
}

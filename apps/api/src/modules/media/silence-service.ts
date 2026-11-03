import { randomUUID } from 'node:crypto';
import {
  SILENCE_DETECTOR,
  type CompleteSilencesRequest,
  type MediaSilences,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LeaseOwner, MediaStorePort } from '../../ports/media-store.js';
import type { SilenceStorePort } from '../../ports/silence-store.js';
import type { MediaActor, MediaService } from './media-service.js';
import { normalizeSilences } from './silence-map.js';

export interface SilenceServiceDeps {
  readonly store: MediaStorePort;
  readonly silences: SilenceStorePort;
  /** Who sees which media item (404 otherwise), as the stream does (FR-3). */
  readonly media: MediaService;
  readonly now?: () => Date;
}

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/**
 * Silence maps (KBC-044, ADR 0025 §3): the VM worker measures each ready item's audio and
 * the API keeps the pauses; people read them with the stream's access rules. Old items
 * get theirs through a backfill that keeps one silences job in the queue at a time (FR-2).
 */
export class SilenceService {
  private readonly now: () => Date;

  constructor(private readonly deps: SilenceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The item's pauses for a person who may play it; pending until measured. */
  forPerson(actor: MediaActor, mediaId: string): MediaSilences {
    const item = this.deps.media.get(actor, mediaId);
    if (item.status !== 'ready')
      throw new AppError('MEDIA_NOT_READY', 'This media cannot be played yet');
    const map = this.deps.silences.mapOf(mediaId);
    if (!map)
      return {
        status: this.deps.silences.gaveUp(mediaId, SILENCE_DETECTOR.version)
          ? 'failed'
          : 'pending',
        version: null,
        minSilenceMs: SILENCE_DETECTOR.minSilenceMs,
        intervals: [],
      };
    return {
      status: 'ready',
      version: map.detector.version,
      minSilenceMs: map.detector.minSilenceMs,
      intervals: [...map.intervals],
    };
  }

  /** The worker's result for a job it holds; then the next backfill job is queued. */
  complete(owner: LeaseOwner, done: CompleteSilencesRequest): void {
    const mediaId = this.deps.silences.heldSilencesJob(owner);
    if (!mediaId) throw leaseLost();
    if (done.detectorVersion !== SILENCE_DETECTOR.version)
      throw new AppError('VALIDATION_FAILED', 'Unknown detector version', {
        details: { field: 'detectorVersion' },
      });
    const durationMs = this.deps.store.getMedia(mediaId)?.durationMs ?? null;
    const stored = this.deps.silences.completeSilences({
      owner,
      map: {
        mediaId,
        detector: SILENCE_DETECTOR,
        intervals: normalizeSilences(done.intervals, durationMs),
        elapsedMs: done.elapsedMs,
      },
      now: this.now(),
    });
    if (!stored) throw leaseLost();
    this.backfill();
  }

  /** Queues the next item without a current map, if no silences job is waiting (FR-2). */
  backfill(): string | null {
    return this.deps.silences.queueBackfill({
      detectorVersion: SILENCE_DETECTOR.version,
      jobId: randomUUID(),
      now: this.now(),
    });
  }
}

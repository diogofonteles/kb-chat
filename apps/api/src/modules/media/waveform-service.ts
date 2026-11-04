import { randomUUID } from 'node:crypto';
import {
  WAVEFORM,
  type CompleteWaveformRequest,
  type MediaWaveform,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { WaveformStorePort } from '../../ports/waveform-store.js';
import type { MediaActor, MediaService } from './media-service.js';

export interface WaveformServiceDeps {
  readonly waveforms: WaveformStorePort;
  /** Who sees which media item (404 otherwise), as the stream does. */
  readonly media: MediaService;
  readonly now?: () => Date;
}

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/**
 * Waveforms (KBC-066, ADR 0029 §4): the VM worker measures each ready item's audio and the
 * API keeps the peaks for the track validation screen. Old items get theirs through a
 * backfill that keeps one waveform job in the queue at a time.
 */
export class WaveformService {
  private readonly now: () => Date;

  constructor(private readonly deps: WaveformServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The item's peaks for a person who may play it; pending until measured. */
  forPerson(actor: MediaActor, mediaId: string): MediaWaveform {
    const item = this.deps.media.get(actor, mediaId);
    if (item.status !== 'ready')
      throw new AppError('MEDIA_NOT_READY', 'This media cannot be played yet');
    const { waveforms } = this.deps;
    const { peaksPerSecond, version } = WAVEFORM;
    const waveform = waveforms.waveformOf(mediaId);
    if (waveform)
      return {
        status: 'ready',
        peaksPerSecond,
        peaks: Buffer.from(waveform.peaks).toString('base64'),
      };
    return {
      status: waveforms.gaveUp(mediaId, version) ? 'failed' : 'pending',
      peaksPerSecond,
      peaks: '',
    };
  }

  /** The worker's result for a job it holds; then the next backfill job is queued. */
  complete(owner: LeaseOwner, done: CompleteWaveformRequest): void {
    const mediaId = this.deps.waveforms.heldJob(owner);
    if (!mediaId) throw leaseLost();
    if (done.version !== WAVEFORM.version)
      throw new AppError('VALIDATION_FAILED', 'Unknown waveform version', {
        details: { field: 'version' },
      });
    const stored = this.deps.waveforms.complete({
      owner,
      waveform: {
        mediaId,
        version: done.version,
        peaks: Buffer.from(done.peaks, 'base64'),
      },
      elapsedMs: done.elapsedMs,
      now: this.now(),
    });
    if (!stored) throw leaseLost();
    this.backfill();
  }

  /** Queues the next item without peaks, if no waveform job is waiting. */
  backfill(): string | null {
    return this.deps.waveforms.queueBackfill({
      version: WAVEFORM.version,
      jobId: randomUUID(),
      now: this.now(),
    });
  }
}

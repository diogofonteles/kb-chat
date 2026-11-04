import type { FastifyBaseLogger } from 'fastify';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import { MAX_JOB_ATTEMPTS, UPLOAD_ABANDON_MS } from './media-policy.js';

export interface MediaJanitorDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  readonly log: FastifyBaseLogger;
  /** Queues the next silence map of an older item, one at a time (KBC-044 FR-2). */
  readonly backfillSilences?: () => string | null;
  /** Queues the next waveform of an older item, one at a time (KBC-066). */
  readonly backfillWaveforms?: () => string | null;
  /** The guided flow goes on with no page open (KBC-072 BR-8). */
  readonly advancePreparations?: () => Promise<void>;
  readonly now?: () => Date;
}

export interface SweepResult {
  readonly requeued: number;
  readonly failed: number;
  readonly abandoned: number;
}

/**
 * The queue's janitor (ADR 0022 §2): jobs whose worker stopped beating go back to the
 * queue, or fail after the last attempt; uploads left unfinished for a day are dropped;
 * items without a silence map (KBC-044 FR-2) or peaks (KBC-066) get one queued, one at a
 * time.
 */
export class MediaJanitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: MediaJanitorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async sweep(): Promise<SweepResult> {
    const now = this.now();
    const reaped = this.deps.store.reapExpired({
      now,
      maxAttempts: MAX_JOB_ATTEMPTS,
    });
    const abandoned = this.deps.store.abandonUploads({
      olderThan: new Date(now.getTime() - UPLOAD_ABANDON_MS),
      now,
    });
    for (const mediaId of abandoned)
      await this.deps.files.discardUpload(mediaId);
    // A transcription given up keeps no FLAC: a new one is served the AAC rendition.
    const { files } = this.deps;
    await files.remove(
      reaped.transcriptionsGivenUp.map((id) => files.flacPath(id)),
    );
    this.backfill();
    await this.deps.advancePreparations?.();
    const result = {
      requeued: reaped.requeued,
      failed: reaped.failed,
      abandoned: abandoned.length,
    };
    if (result.requeued + result.failed + result.abandoned > 0)
      this.deps.log.info({ media: result }, 'media janitor sweep');
    return result;
  }

  /** One older item per sweep gets what it lacks. */
  private backfill(): void {
    const backfilled = this.deps.backfillSilences?.() ?? null;
    if (backfilled)
      this.deps.log.info({ mediaId: backfilled }, 'silence map queued');
    const waveform = this.deps.backfillWaveforms?.() ?? null;
    if (waveform) this.deps.log.info({ mediaId: waveform }, 'waveform queued');
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      this.sweep().catch((err: unknown) =>
        this.deps.log.error({ err }, 'media janitor sweep failed'),
      );
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

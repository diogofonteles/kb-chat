import type { FastifyBaseLogger } from 'fastify';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import { MAX_JOB_ATTEMPTS, UPLOAD_ABANDON_MS } from './media-policy.js';

export interface MediaJanitorDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  readonly log: FastifyBaseLogger;
  readonly now?: () => Date;
}

export interface SweepResult {
  readonly requeued: number;
  readonly failed: number;
  readonly abandoned: number;
}

/**
 * The queue's janitor (ADR 0022 §2): jobs whose worker stopped beating go back to the
 * queue, or fail after the last attempt; uploads left unfinished for a day are dropped.
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
    const result = {
      requeued: reaped.requeued,
      failed: reaped.failed,
      abandoned: abandoned.length,
    };
    if (result.requeued + result.failed + result.abandoned > 0)
      this.deps.log.info({ media: result }, 'media janitor sweep');
    return result;
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

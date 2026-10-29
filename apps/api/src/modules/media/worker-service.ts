import type {
  CompleteTranscodeRequest,
  FailJobRequest,
  HeartbeatRequest,
  LeaseRequest,
  WorkerJob,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import { AUDIO_MIME, JOB_LEASE_MS, MAX_JOB_ATTEMPTS } from './media-policy.js';

export interface WorkerServiceDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  readonly now?: () => Date;
}

const leaseOf = (done: CompleteTranscodeRequest) => ({
  worker: done.worker,
  leaseId: done.leaseId,
});

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/**
 * The media worker's side of the queue (ADR 0022 §3): lease a job, beat, finish or fail
 * it. Each call names its lease; a worker that lost it gets 409 and drops its work.
 */
export class WorkerService {
  private readonly now: () => Date;

  constructor(private readonly deps: WorkerServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  lease(request: LeaseRequest): WorkerJob | null {
    const job = this.deps.store.leaseJob({
      kinds: request.kinds,
      worker: request.worker,
      now: this.now(),
      leaseMs: JOB_LEASE_MS,
    });
    if (!job) return null;
    return {
      ...job,
      sourcePath: this.deps.files.uploadPath(job.mediaId),
      targetPath: this.deps.files.workPath(job.mediaId, job.leaseId),
      leaseMs: JOB_LEASE_MS,
    };
  }

  heartbeat(jobId: string, beat: HeartbeatRequest): void {
    const held = this.deps.store.heartbeat({
      jobId,
      ...beat,
      now: this.now(),
      leaseMs: JOB_LEASE_MS,
    });
    if (!held) throw leaseLost();
  }

  /**
   * The lease's work file is on disk with the announced size: it becomes the rendition and
   * the upload goes (BR-4).
   */
  async completeTranscode(
    jobId: string,
    done: CompleteTranscodeRequest,
  ): Promise<void> {
    const mediaId = this.deps.store.mediaOfJob(jobId);
    if (!mediaId) throw leaseLost();
    await this.assertWorkFile(mediaId, done);
    await this.assertStillLeased(jobId, mediaId, done);
    const path = await this.promote(mediaId, done.leaseId);
    const finished = this.deps.store.completeTranscode({
      ...done,
      jobId,
      now: this.now(),
      rendition: {
        mediaId,
        rendition: 'audio',
        path,
        bytes: done.bytes,
        mime: AUDIO_MIME,
      },
    });
    // The rendition is in place; if the lease is gone because the item was removed
    // meanwhile, the file must not stay behind (the removal already ran).
    if (!finished) {
      if (!this.deps.store.getMedia(mediaId))
        await this.deps.files.remove([path]);
      throw leaseLost();
    }
    await this.deps.files.discardUpload(mediaId);
  }

  /**
   * The lease must still be ours before the file moves (a beat checks it); when it is gone,
   * this work file is nobody's.
   */
  private async assertStillLeased(
    jobId: string,
    mediaId: string,
    done: CompleteTranscodeRequest,
  ): Promise<void> {
    try {
      this.heartbeat(jobId, { ...leaseOf(done), progress: 100 });
    } catch (err) {
      const { files } = this.deps;
      await files.remove([files.workPath(mediaId, done.leaseId)]);
      throw err;
    }
  }

  /** The lease's work file becomes the rendition (an atomic rename). */
  private async promote(mediaId: string, leaseId: string): Promise<string> {
    const { files } = this.deps;
    const path = files.audioPath(mediaId);
    await files.promote(files.workPath(mediaId, leaseId), path);
    return path;
  }

  private async assertWorkFile(
    mediaId: string,
    done: CompleteTranscodeRequest,
  ): Promise<void> {
    const file = await this.deps.files.stat(
      this.deps.files.workPath(mediaId, done.leaseId),
    );
    if (!file || file.size !== done.bytes)
      throw new AppError(
        'VALIDATION_FAILED',
        'The converted file is not on disk',
        {
          details: { field: 'bytes' },
        },
      );
  }

  /**
   * A bad file is given up at once and its original goes (BR-4: nothing could ever use
   * it). A crash keeps the original: the job is retried, or a master may "Tentar de novo".
   */
  async fail(jobId: string, failure: FailJobRequest): Promise<void> {
    const mediaId = this.deps.store.mediaOfJob(jobId);
    const recorded = this.deps.store.failJob({
      jobId,
      ...failure,
      now: this.now(),
      maxAttempts: MAX_JOB_ATTEMPTS,
    });
    if (!recorded) throw leaseLost();
    if (failure.failure === 'invalid-audio' && mediaId)
      await this.deps.files.discardUpload(mediaId);
  }
}

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
   * the upload goes (BR-4). The lease is checked (by a beat) before the file is moved.
   */
  async completeTranscode(
    jobId: string,
    done: CompleteTranscodeRequest,
  ): Promise<void> {
    const mediaId = this.deps.store.mediaOfJob(jobId);
    if (!mediaId) throw leaseLost();
    await this.assertWorkFile(mediaId, done);
    this.heartbeat(jobId, {
      worker: done.worker,
      leaseId: done.leaseId,
      progress: 100,
    });
    const { files, store } = this.deps;
    const path = files.audioPath(mediaId);
    await files.promote(files.workPath(mediaId, done.leaseId), path);
    const rendition = {
      mediaId,
      rendition: 'audio',
      path,
      bytes: done.bytes,
    } as const;
    const finished = store.completeTranscode({
      ...done,
      jobId,
      now: this.now(),
      rendition: { ...rendition, mime: AUDIO_MIME },
    });
    if (!finished) throw leaseLost();
    await files.discardUpload(mediaId);
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

  fail(jobId: string, failure: FailJobRequest): void {
    const recorded = this.deps.store.failJob({
      jobId,
      ...failure,
      now: this.now(),
      maxAttempts: MAX_JOB_ATTEMPTS,
    });
    if (!recorded) throw leaseLost();
  }
}

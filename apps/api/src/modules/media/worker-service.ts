import { randomUUID } from 'node:crypto';
import {
  SILENCE_DETECTOR,
  type CompleteTranscodeRequest,
  type FailJobRequest,
  type HeartbeatRequest,
  type LeaseRequest,
  type LeasedWorkerJob,
  type MediaJobKind,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { LeasedJob, MediaStorePort } from '../../ports/media-store.js';
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

const audioRendition = (mediaId: string, path: string) =>
  ({ mediaId, rendition: 'audio', path, mime: AUDIO_MIME }) as const;

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

  /**
   * The oldest job of the asked kinds. A conversion names its files on the shared disk; a
   * transcription names the route its audio is fetched from (the Mac has no shared disk).
   */
  lease(
    request: LeaseRequest & { readonly oneAtATime?: boolean },
  ): LeasedWorkerJob | null {
    const job = this.deps.store.leaseJob({
      kinds: request.kinds,
      worker: request.worker,
      oneAtATime: request.oneAtATime,
      now: this.now(),
      leaseMs: JOB_LEASE_MS,
    });
    if (!job) return null;
    if (job.kind === 'silences') return this.silencesJob(job);
    return job.kind === 'transcribe'
      ? this.transcribeJob(job)
      : {
          ...job,
          kind: 'transcode',
          sourcePath: this.deps.files.uploadPath(job.mediaId),
          targetPath: this.deps.files.workPath(job.mediaId, job.leaseId),
          flacTargetPath: this.deps.files.flacWorkPath(
            job.mediaId,
            job.leaseId,
          ),
          leaseMs: JOB_LEASE_MS,
        };
  }

  /** Measuring the audio rendition on the shared disk (KBC-044 FR-1). */
  private silencesJob(job: LeasedJob): LeasedWorkerJob {
    const rendition = this.deps.store.getRendition(job.mediaId);
    return {
      ...job,
      kind: 'silences',
      leaseMs: JOB_LEASE_MS,
      sourcePath: rendition?.path ?? this.deps.files.audioPath(job.mediaId),
      detector: SILENCE_DETECTOR,
    };
  }

  private transcribeJob(job: LeasedJob): LeasedWorkerJob {
    return {
      ...job,
      kind: 'transcribe',
      leaseMs: JOB_LEASE_MS,
      durationMs: this.deps.store.getMedia(job.mediaId)?.durationMs ?? null,
      audioPath: `/api/v1/media-worker/jobs/${job.id}/audio`,
    };
  }

  /** What a job is, for the routes to check it against the token's kinds (BR-2). */
  kindOf(jobId: string): MediaJobKind | null {
    return this.deps.store.kindOfJob(jobId);
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
    await this.promoteFlac(mediaId, done);
    const finished = this.deps.store.completeTranscode({
      ...done,
      jobId,
      transcribeJobId: randomUUID(),
      silencesJobId: randomUUID(),
      now: this.now(),
      rendition: { ...audioRendition(mediaId, path), bytes: done.bytes },
    });
    // The rendition is in place; if the lease is gone because the item was removed
    // meanwhile, the file must not stay behind (the removal already ran).
    if (!finished) {
      if (!this.deps.store.getMedia(mediaId))
        await this.deps.files.remove([path, this.deps.files.flacPath(mediaId)]);
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

  /**
   * The FLAC for the transcriber, when the worker made one with the announced size; a
   * missing one is no failure: the transcriber then gets the audio rendition.
   */
  private async promoteFlac(
    mediaId: string,
    done: CompleteTranscodeRequest,
  ): Promise<void> {
    const { files } = this.deps;
    const work = files.flacWorkPath(mediaId, done.leaseId);
    const file = await files.stat(work);
    if (done.flacBytes !== undefined && file?.size === done.flacBytes)
      await files.promote(work, files.flacPath(mediaId));
    else await files.remove([work]);
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
    const kind = this.deps.store.kindOfJob(jobId);
    const recorded = this.deps.store.failJob({
      jobId,
      ...failure,
      now: this.now(),
      maxAttempts: MAX_JOB_ATTEMPTS,
    });
    if (!recorded) throw leaseLost();
    if (!mediaId) return;
    if (kind === 'transcribe') return this.afterTranscriptionFailure(mediaId);
    if (failure.failure === 'invalid-audio')
      await this.deps.files.discardUpload(mediaId);
  }

  /** A transcription given up for good keeps no FLAC (ADR 0022 §4: made for it only). */
  private async afterTranscriptionFailure(mediaId: string): Promise<void> {
    const status = this.deps.store.getMedia(mediaId)?.transcription.jobStatus;
    if (status === 'failed' || status === 'dead')
      await this.deps.files.remove([this.deps.files.flacPath(mediaId)]);
  }
}

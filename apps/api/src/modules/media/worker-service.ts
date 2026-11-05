import { randomUUID } from 'node:crypto';
import {
  SILENCE_DETECTOR,
  WAVEFORM,
  type CompleteTranscodeRequest,
  type FailJobRequest,
  type GroqTranscribeJob,
  type HeartbeatRequest,
  type LeaseRequest,
  type LeasedWorkerJob,
  type MediaJobKind,
  type TranscribeJob,
  type TranscriptionRoute,
  type VoiceProfileJob,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { LeasedJob, MediaStorePort } from '../../ports/media-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
import { AUDIO_MIME, JOB_LEASE_MS, MAX_JOB_ATTEMPTS } from './media-policy.js';

export interface WorkerServiceDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  /** What a leased `voice-profile` job carries (KBC-071). */
  readonly voiceJobOf?: (job: LeasedJob) => VoiceProfileJob;
  /** The current term list's version, for a Groq job's prompts (KBC-037). */
  readonly termsVersion?: () => number;
  /** What a cut job cuts (KBC-068). */
  readonly tracks?: Pick<TrackItemStorePort, 'cutOrder'>;
  readonly now?: () => Date;
}

const leaseOf = (done: CompleteTranscodeRequest) => ({
  worker: done.worker,
  leaseId: done.leaseId,
});

const audioRendition = (mediaId: string, path: string) =>
  ({ mediaId, rendition: 'audio', path, mime: AUDIO_MIME }) as const;

/** A leased job as the protocol names it: only a separation carries the voices hint. */
const withoutHint = (job: LeasedJob) => ({
  id: job.id,
  leaseId: job.leaseId,
  mediaId: job.mediaId,
  attempt: job.attempt,
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

  /**
   * The oldest job of the asked kinds. A conversion names its files on the shared disk; a
   * transcription names the route its audio is fetched from (the Mac has no shared disk).
   */
  lease(
    request: LeaseRequest & {
      readonly oneAtATime?: boolean;
      readonly transcribeRoute?: TranscriptionRoute;
    },
  ): LeasedWorkerJob | null {
    const job = this.deps.store.leaseJob({
      kinds: request.kinds,
      worker: request.worker,
      oneAtATime: request.oneAtATime,
      transcribeRoute: request.transcribeRoute,
      now: this.now(),
      leaseMs: JOB_LEASE_MS,
    });
    if (!job) return null;
    if (job.kind === 'transcribe' && request.transcribeRoute === 'groq')
      return this.groqJob(job);
    if (job.kind === 'silences') return this.silencesJob(job);
    if (job.kind === 'waveform') return this.waveformJob(job);
    if (job.kind === 'diarize') return this.diarizeJob(job);
    if (job.kind === 'voice-profile') return this.voiceProfileJob(job);
    if (job.kind === 'cut') return this.cutJob(job);
    return job.kind === 'transcribe'
      ? this.transcribeJob(job)
      : this.transcodeJob(job);
  }

  /** A conversion names its files on the shared disk, the FLAC beside it (ADR 0022 §4). */
  private transcodeJob(job: LeasedJob): LeasedWorkerJob {
    const { files } = this.deps;
    return {
      ...withoutHint(job),
      kind: 'transcode',
      sourcePath: files.uploadPath(job.mediaId),
      targetPath: files.workPath(job.mediaId, job.leaseId),
      flacTargetPath: files.flacWorkPath(job.mediaId, job.leaseId),
      leaseMs: JOB_LEASE_MS,
    };
  }

  /** Measuring the audio rendition on the shared disk (KBC-044 FR-1). */
  private silencesJob(job: LeasedJob): LeasedWorkerJob {
    const rendition = this.deps.store.getRendition(job.mediaId);
    return {
      ...withoutHint(job),
      kind: 'silences',
      leaseMs: JOB_LEASE_MS,
      sourcePath: rendition?.path ?? this.deps.files.audioPath(job.mediaId),
      detector: SILENCE_DETECTOR,
    };
  }

  /** Measuring the peaks of the audio rendition on the shared disk (KBC-066). */
  private waveformJob(job: LeasedJob): LeasedWorkerJob {
    const rendition = this.deps.store.getRendition(job.mediaId);
    return {
      ...withoutHint(job),
      kind: 'waveform',
      leaseMs: JOB_LEASE_MS,
      sourcePath: rendition?.path ?? this.deps.files.audioPath(job.mediaId),
      ...WAVEFORM,
    };
  }

  /** Copying a track out of its recording's rendition, on the shared disk (KBC-068 FR-2). */
  private cutJob(job: LeasedJob): LeasedWorkerJob {
    const order = this.deps.tracks?.cutOrder(job.mediaId);
    if (!order) throw new Error(`cut job ${job.id} has no track`);
    return {
      ...withoutHint(job),
      kind: 'cut',
      leaseMs: JOB_LEASE_MS,
      targetPath: this.deps.files.workPath(job.mediaId, job.leaseId),
      ...order,
    };
  }

  /** A separation fetches the same audio as a transcription, with its hint (KBC-064). */
  private diarizeJob(job: LeasedJob): LeasedWorkerJob {
    return { ...this.transcribeJob(job), kind: 'diarize', voices: job.voices };
  }

  private voiceProfileJob(job: LeasedJob): VoiceProfileJob {
    if (!this.deps.voiceJobOf)
      throw new Error('A voice profile job needs the voice profile service');
    return this.deps.voiceJobOf(job);
  }

  private transcribeJob(job: LeasedJob): TranscribeJob {
    return {
      ...withoutHint(job),
      kind: 'transcribe',
      leaseMs: JOB_LEASE_MS,
      durationMs: this.deps.store.getMedia(job.mediaId)?.durationMs ?? null,
      audioPath: `/api/v1/media-worker/jobs/${job.id}/audio`,
    };
  }

  /**
   * A transcription routed to Groq (KBC-037): the VM reads the audio on the shared disk, the
   * FLAC or, once it is gone, the rendition, and prompts with the current term list.
   */
  private groqJob(job: LeasedJob): GroqTranscribeJob {
    const { files, store } = this.deps;
    return {
      ...withoutHint(job),
      kind: 'transcribe',
      provider: 'groq',
      leaseMs: JOB_LEASE_MS,
      durationMs: store.getMedia(job.mediaId)?.durationMs ?? null,
      sourcePath: files.flacPath(job.mediaId),
      renditionPath: store.getRendition(job.mediaId)?.path ?? null,
      termsVersion: this.deps.termsVersion?.() ?? 1,
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
      waveformJobId: randomUUID(),
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
    // ADR 0022 §4: the FLAC is made for the transcription; none was asked (KBC-072).
    if (this.deps.store.skipsTranscription(mediaId))
      await this.deps.files.remove([this.deps.files.flacPath(mediaId)]);
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

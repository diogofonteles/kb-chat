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
  type DocIngestJob,
  type WorkerLeasedJob,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type {
  LeasedJob,
  LeaseOwner,
  MediaStorePort,
} from '../../ports/media-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
import { AUDIO_MIME, JOB_LEASE_MS, MAX_JOB_ATTEMPTS } from './media-policy.js';

export interface WorkerServiceDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  /** What a leased `voice-profile` job carries (KBC-071). */
  readonly voiceJobOf?: (job: LeasedJob) => VoiceProfileJob;
  /** The current term list's version, for a Groq job's prompts (KBC-037). */
  readonly termsVersion?: () => number;
  /**
   * Groq asked for a long wait (KBC-037): until it is over the VM leaves its transcriptions
   * in the queue and takes only conversions and measures.
   */
  readonly groqWaits?: () => boolean;
  /** What a cut job cuts (KBC-068). */
  readonly tracks?: Pick<TrackItemStorePort, 'cutOrder'>;
  /** The kb-publish queue (KBC-099), kept apart from `jobs`: it has no media item. */
  readonly kb?: KbPublishQueue;
  /** Documents and links sent from the app (KBC-149, ADR 0040): no media item either. */
  readonly docs?: DocIngestJobs;
  readonly now?: () => Date;
}

/** The doc-ingest queue as the worker protocol sees it (leased like kb-publish). */
export interface DocIngestJobs {
  lease(worker: string): DocIngestJob | null;
  isJob(jobId: string): boolean;
  heartbeat(owner: LeaseOwner): void;
  fail(
    owner: LeaseOwner,
    failure: {
      readonly detail: string;
      readonly configuration?: boolean;
      readonly spendUsd?: number;
    },
  ): Promise<void>;
  isHeldBy(worker: string): boolean;
}

/** A collection's track documents for the Mac to write and pass through kb (ADR 0035 §3). */
export interface KbPublishQueue {
  lease(worker: string): LeasedWorkerJob | null;
  isJob(jobId: string): boolean;
  heartbeat(owner: LeaseOwner): void;
  /**
   * kb's output, and what kb spent before failing (ADR 0035 §11); `configuration` when the
   * Mac is not set up (KBC-117): the job waits, spending no attempt.
   */
  fail(
    owner: LeaseOwner,
    failure: {
      readonly detail: string;
      readonly spendUsd?: number;
      readonly configuration?: boolean;
    },
  ): void;
  /** Whether this worker holds a kb-publish lease now. */
  isHeldBy?(worker: string): boolean;
}

/** Sent documents one worker takes before a recording's turn (KBC-184). */
export const DOCUMENTS_IN_A_ROW = 5;
const KB_PUBLISH = 'kb-publish';
const DOC_INGEST = 'doc-ingest';
/** The queues kept apart from `jobs` (no media item). */
const OWN_QUEUES: readonly MediaJobKind[] = [KB_PUBLISH, DOC_INGEST];

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
  private readonly documentsInARow = new Map<string, number>();

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
  ): WorkerLeasedJob | null {
    // ADR 0023: one job at a time, whichever queue it came from.
    if (request.oneAtATime && this.holdsOwnQueueLease(request.worker))
      return null;
    const document = this.leaseDocsFirst(request);
    if (document) return document;
    const job = this.leaseMediaJob(request);
    if (!job) return this.leaseKb(request) ?? this.leaseDocs(request);
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

  /**
   * A document takes a minute and a recording many: documents go first, a few in a row, then
   * what else waits has its turn (a folder of hundreds must not hold the recordings back).
   */
  private leaseDocsFirst(
    request: LeaseRequest & { readonly oneAtATime?: boolean },
  ): WorkerLeasedJob | null {
    const { worker } = request;
    const inARow = this.documentsInARow.get(worker) ?? 0;
    const document = inARow < DOCUMENTS_IN_A_ROW && this.leaseDocs(request);
    this.documentsInARow.set(worker, document ? inARow + 1 : 0);
    return document || null;
  }

  private kindsFor(request: {
    readonly kinds: readonly MediaJobKind[];
    readonly transcribeRoute?: TranscriptionRoute;
  }): MediaJobKind[] {
    const groqWaits =
      request.transcribeRoute === 'groq' && this.deps.groqWaits?.() === true;
    return request.kinds.filter((kind) => !groqWaits || kind !== 'transcribe');
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

  /** The oldest job of the asked kinds in `jobs` (every kind but kb-publish). */
  private leaseMediaJob(
    request: LeaseRequest & {
      readonly oneAtATime?: boolean;
      readonly transcribeRoute?: TranscriptionRoute;
    },
  ): LeasedJob | null {
    const kinds = this.kindsFor(request).filter(
      (kind) => !OWN_QUEUES.includes(kind),
    );
    if (kinds.length === 0) return null;
    return this.deps.store.leaseJob({
      kinds,
      worker: request.worker,
      oneAtATime: request.oneAtATime,
      transcribeRoute: request.transcribeRoute,
      now: this.now(),
      leaseMs: JOB_LEASE_MS,
    });
  }

  /** Track documents wait behind the media jobs of the same transcriber (ADR 0035 §3). */
  private leaseKb(
    request: LeaseRequest & { readonly oneAtATime?: boolean },
  ): LeasedWorkerJob | null {
    const { kb, store } = this.deps;
    if (!kb || !request.kinds.includes(KB_PUBLISH)) return null;
    if (request.oneAtATime && store.holdsLease(request.worker)) return null;
    return kb.lease(request.worker);
  }

  private holdsOwnQueueLease(worker: string): boolean {
    return (
      this.deps.kb?.isHeldBy?.(worker) === true ||
      this.deps.docs?.isHeldBy(worker) === true
    );
  }

  /** Sent documents wait behind the media jobs and the track documents (ADR 0040). */
  private leaseDocs(
    request: LeaseRequest & { readonly oneAtATime?: boolean },
  ): DocIngestJob | null {
    const { docs, store } = this.deps;
    if (!docs || !request.kinds.includes(DOC_INGEST)) return null;
    if (request.oneAtATime && store.holdsLease(request.worker)) return null;
    return docs.lease(request.worker);
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
    const kind = this.deps.store.kindOfJob(jobId);
    if (kind) return kind;
    if (this.deps.kb?.isJob(jobId)) return KB_PUBLISH;
    return this.deps.docs?.isJob(jobId) ? DOC_INGEST : null;
  }

  heartbeat(jobId: string, beat: HeartbeatRequest): void {
    if (this.deps.docs?.isJob(jobId)) {
      this.deps.docs.heartbeat({
        jobId,
        worker: beat.worker,
        leaseId: beat.leaseId,
      });
      return;
    }
    if (this.deps.kb?.isJob(jobId)) {
      this.deps.kb.heartbeat({
        jobId,
        worker: beat.worker,
        leaseId: beat.leaseId,
      });
      return;
    }
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
    if (await this.failOwnQueue(jobId, failure)) return;
    const mediaId = this.deps.store.mediaOfJob(jobId);
    const kind = this.deps.store.kindOfJob(jobId);
    const recorded = this.deps.store.failJob({
      jobId,
      ...failure,
      // Only a kb-publish job waits for the Mac's setup (KBC-117); any other is a crash.
      failure:
        failure.failure === 'not-configured'
          ? 'conversion-failed'
          : failure.failure,
      now: this.now(),
      maxAttempts: MAX_JOB_ATTEMPTS,
    });
    if (!recorded) throw leaseLost();
    if (!mediaId) return;
    if (kind === 'transcribe') return this.afterTranscriptionFailure(mediaId);
    if (failure.failure === 'invalid-audio')
      await this.deps.files.discardUpload(mediaId);
  }

  /** A kb-publish or doc-ingest job: kept apart from `jobs`; false for any other. */
  private async failOwnQueue(
    jobId: string,
    failure: FailJobRequest,
  ): Promise<boolean> {
    const queue = this.deps.docs?.isJob(jobId)
      ? this.deps.docs
      : this.deps.kb?.isJob(jobId)
        ? this.deps.kb
        : null;
    if (!queue) return false;
    const owner = { jobId, worker: failure.worker, leaseId: failure.leaseId };
    await queue.fail(owner, {
      detail: failure.detail,
      configuration: failure.failure === 'not-configured',
      ...(failure.spendUsd !== undefined && { spendUsd: failure.spendUsd }),
    });
    return true;
  }

  /** A transcription given up for good keeps no FLAC (ADR 0022 §4: made for it only). */
  private async afterTranscriptionFailure(mediaId: string): Promise<void> {
    const status = this.deps.store.getMedia(mediaId)?.transcription.jobStatus;
    if (status === 'failed' || status === 'dead')
      await this.deps.files.remove([this.deps.files.flacPath(mediaId)]);
  }
}

import { randomUUID } from 'node:crypto';
import type {
  CompleteDiarizeRequest,
  DiarizationStatus,
  Diarization,
  DiarizeRequest,
  MediaSpeakers,
  SpeakerTurn,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  DiarizationStorePort,
  DiarizationSummary,
  DiarizeJobRecord,
  NewDiarization,
} from '../../ports/diarization-store.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type {
  JobStatus,
  LeaseOwner,
  MediaRecord,
  MediaStorePort,
} from '../../ports/media-store.js';
import type {
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import type { MediaActor } from './media-service.js';
import {
  DERIVATION_VERSION,
  deriveTurns,
  dominantVoices,
  speakingTimeOf,
  voiceCountOf,
  wordVoicesOf,
} from './speaker-turns.js';
import type { Presence } from './transcriber-service.js';

export interface DiarizationServiceDeps {
  readonly store: MediaStorePort;
  readonly transcripts: TranscriptStorePort;
  readonly diarizations: DiarizationStorePort;
  readonly files: MediaFilesPort;
  /** Whether a transcriber that separates voices is on (AC-9). */
  readonly presence?: () => Presence;
  readonly now?: () => Date;
}

/** A turn may end this far past the item's length (the decoder rounds the last frame). */
const END_SLACK_MS = 2_000;

const NO_TRANSCRIBER: Presence = { transcriber: 'none', offSince: null };

const notFound = () => new AppError('MEDIA_NOT_FOUND', 'Unknown media');
const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/**
 * The newest job decides: waiting, running, failed (the earlier result, if any, stays in the
 * body) or done; with no job, a stored separation means done.
 */
const STATUS_BY_JOB: Record<
  JobStatus,
  (hasResult: boolean) => DiarizationStatus
> = {
  queued: () => 'waiting',
  leased: () => 'diarizing',
  done: (has) => (has ? 'done' : 'none'),
  // A failed new run says so, even with an earlier result still shown (QA BUG-2).
  failed: () => 'failed',
  dead: () => 'failed',
};

function statusOf(
  job: DiarizeJobRecord | null,
  result: DiarizationSummary | null,
): DiarizationStatus {
  if (job) return STATUS_BY_JOB[job.status](result !== null);
  return result ? 'done' : 'none';
}

const isPending = (job: DiarizeJobRecord | null): boolean =>
  job?.status === 'queued' || job?.status === 'leased';

/** How a separation was made: the worker's engine, model, parameters and hint. */
const provenanceOf = (done: CompleteDiarizeRequest) => ({
  engine: done.engine,
  model: done.model,
  parameters: JSON.stringify(done.parameters),
  parametersVersion: done.parametersVersion,
  requestedVoices: done.requestedVoices,
  elapsedMs: done.elapsedMs,
});

/** The raw result as stored: everything the worker sent but its lease (ADR 0029 §1). */
const rawFileOf = (done: CompleteDiarizeRequest): string =>
  JSON.stringify({
    engine: done.engine,
    model: done.model,
    parametersVersion: done.parametersVersion,
    parameters: done.parameters,
    requestedVoices: done.requestedVoices,
    elapsedMs: done.elapsedMs,
    raw: done.raw,
  });

/**
 * Separating the voices of a recording (KBC-064, ADR 0029 §1): a person with `media-edit`
 * asks for it, a paired transcriber leases the job on the owner's Mac and sends only the
 * turns; the API keeps the raw file and derives the turns and the voice of each segment and
 * word. No voice print ever reaches the API (BR-1).
 */
export class DiarizationService {
  private readonly now: () => Date;

  constructor(private readonly deps: DiarizationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** "Separar vozes" (FR-1): needs a current transcript and nothing queued or running. */
  request(
    actor: MediaActor,
    mediaId: string,
    request: DiarizeRequest,
  ): MediaSpeakers {
    const media = this.visible(actor, mediaId);
    const [transcript] = this.deps.transcripts.transcripts(mediaId);
    if (media.status !== 'ready' || !transcript)
      throw new AppError(
        'MEDIA_NOT_READY',
        'This media has no transcript to separate voices on',
      );
    const queued = this.deps.diarizations.requestDiarization({
      mediaId,
      jobId: randomUUID(),
      voices: request.voices ?? null,
      now: this.now(),
    });
    if (!queued)
      throw new AppError(
        'MEDIA_CONFLICT',
        'A voice separation is already waiting or running',
      );
    return this.speakers(actor, mediaId);
  }

  /** The current separation read on the current transcript (FR-4), with its status. */
  speakers(actor: MediaActor, mediaId: string): MediaSpeakers {
    const media = this.visible(actor, mediaId);
    const { diarizations, transcripts } = this.deps;
    const job = diarizations.latestJob(mediaId);
    const result = diarizations.latest(mediaId);
    const [transcript] = transcripts.transcripts(mediaId);
    const presence = this.deps.presence?.() ?? NO_TRANSCRIBER;
    return {
      mediaId,
      status: statusOf(job, result),
      transcriber: presence.transcriber,
      transcriberOffSince: presence.offSince,
      canRequest:
        media.status === 'ready' && transcript !== undefined && !isPending(job),
      diarization:
        result && transcript ? this.toDiarization(result, transcript) : null,
    };
  }

  /**
   * The worker's turns (FR-2, FR-3): the raw file is kept and the turns and voices derived
   * on the item's current transcript, stored with the job's end in one transaction.
   */
  async complete(
    owner: LeaseOwner,
    sent: CompleteDiarizeRequest,
  ): Promise<void> {
    const { diarizations, files } = this.deps;
    const job = diarizations.heldDiarization(owner);
    if (!job) throw leaseLost();
    // The hint is the job's (BR-4, AC-6), whatever the worker says it was.
    const done = { ...sent, requestedVoices: job.voices };
    const diarization = this.derive(job.mediaId, done);
    await files.writeFile(diarization.rawPath, rawFileOf(done));
    let stored = false;
    try {
      stored = diarizations.completeDiarize({
        owner,
        now: this.now(),
        diarization,
      });
    } finally {
      if (!stored) await files.remove([diarization.rawPath]);
    }
    if (!stored) throw leaseLost();
  }

  /**
   * Checks the turns against the item and the job, and derives what is stored with them;
   * more voices than the person announced is a wrong result, refused whole.
   */
  private derive(
    mediaId: string,
    done: CompleteDiarizeRequest,
  ): NewDiarization {
    const { transcripts, store, files } = this.deps;
    const durationMs = store.getMedia(mediaId)?.durationMs ?? null;
    assertWithin(done, durationMs);
    const [transcript] = transcripts.transcripts(mediaId);
    if (!transcript)
      throw new AppError('MEDIA_NOT_READY', 'This media has no transcript');
    const turns = deriveTurns(done.raw.turns, durationMs);
    assertVoices(turns, done.requestedVoices);
    const id = randomUUID();
    return {
      id,
      mediaId,
      transcriptId: transcript.id,
      ...provenanceOf(done),
      voiceCount: voiceCountOf(turns),
      rawPath: files.diarizationPath(mediaId, id),
      derivationVersion: DERIVATION_VERSION,
      turns,
      ...this.voicesOn(transcript.id, turns),
    };
  }

  /** The voice of each segment and word of a transcript. */
  private voicesOn(transcriptId: string, turns: readonly SpeakerTurn[]) {
    const { transcripts } = this.deps;
    const segmentVoices = dominantVoices(
      transcripts.segments(transcriptId),
      turns,
    );
    const wordVoices = wordVoicesOf({
      words: transcripts.words(transcriptId),
      turns,
      segmentVoices,
    });
    return { segmentVoices, wordVoices };
  }

  /**
   * On the transcript it was made on, the stored voices; on a newer one (BR-3), the same
   * turns placed on the new segments, flagged as made on an older transcript.
   */
  private toDiarization(
    result: DiarizationSummary,
    transcript: TranscriptSummary,
  ): Diarization {
    const { diarizations, transcripts } = this.deps;
    const turns = diarizations.turns(result.id);
    const segments = transcripts.segments(transcript.id);
    const stale = result.transcriptId !== transcript.id;
    const voices = stale
      ? dominantVoices(segments, turns)
      : diarizations.segmentVoices(result.id);
    return {
      version: result.version,
      createdAt: result.createdAt,
      transcriptVersion: transcript.version,
      staleTranscript: stale,
      requestedVoices: result.requestedVoices,
      voiceCount: result.voiceCount,
      voices: speakingTimeOf(turns),
      turns,
      segments: segments.map((segment, index) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        voice: voices[index] ?? null,
      })),
    };
  }

  private visible(actor: MediaActor, mediaId: string): MediaRecord {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !actor.canSee(media.topic)) throw notFound();
    return media;
  }
}

/** Turns past the item's end are a wrong upload, refused whole (as transcripts are). */
function assertWithin(
  done: CompleteDiarizeRequest,
  durationMs: number | null,
): void {
  if (durationMs === null) return;
  const last = done.raw.turns.reduce(
    (end, turn) => Math.max(end, turn.end * 1000),
    0,
  );
  if (last > durationMs + END_SLACK_MS)
    throw new AppError('VALIDATION_FAILED', 'Turns end after the media', {
      details: { field: 'raw' },
    });
}

/** At most the number of voices the person announced (BR-4). */
function assertVoices(
  turns: readonly SpeakerTurn[],
  requested: number | null,
): void {
  if (requested !== null && voiceCountOf(turns) > requested)
    throw new AppError('VALIDATION_FAILED', 'More voices than were asked for', {
      details: { field: 'raw' },
    });
}

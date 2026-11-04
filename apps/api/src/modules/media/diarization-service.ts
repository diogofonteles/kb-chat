import { randomUUID } from 'node:crypto';
import type {
  CompleteDiarizeRequest,
  DiarizationStatus,
  Diarization,
  DiarizeRequest,
  MediaSpeakers,
  SpeakerTurn,
  TranscriptSpeakers,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  CarriedLabel,
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
  StoredVoiceLabel,
  VoiceLabelStorePort,
} from '../../ports/speaker-store.js';
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
  voiceNumbersOf,
  wordVoicesOf,
} from './speaker-turns.js';
import type { Presence } from './transcriber-service.js';
import type { VoicePrintService } from './voice-print-service.js';
import {
  aliasOf,
  carryLabels,
  mergedOf,
  mergeTurns,
  voiceLabelOf,
  type AuthorLookup,
} from './voice-labels.js';

export interface DiarizationServiceDeps {
  readonly store: MediaStorePort;
  readonly transcripts: TranscriptStorePort;
  readonly diarizations: DiarizationStorePort;
  /** Who the voices are (KBC-065). */
  readonly voiceLabels: VoiceLabelStorePort;
  readonly files: MediaFilesPort;
  /** The author a speaker is linked to (BR-2); without it, the speaker's own name. */
  readonly authorOf?: AuthorLookup;
  /** Whether a transcriber that separates voices is on (AC-9). */
  readonly presence?: () => Presence;
  /** Suggestions by voice (KBC-071): only with voice profiles wired in. */
  readonly voicePrints?: VoicePrintService;
  readonly now?: () => Date;
}

/** A turn may end this far past the item's length (the decoder rounds the last frame). */
const END_SLACK_MS = 2_000;

/** A separation read on a transcript: the separation and the voice of each segment. */
export interface TranscriptVoices {
  readonly speakers: TranscriptSpeakers;
  /** In the transcript's segment order; null where no voice was found. */
  readonly segmentVoices: readonly (number | null)[];
}

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
    if (media.track)
      throw new AppError('MEDIA_CONFLICT', 'A track follows its recording', {
        details: { reason: 'track' },
      });
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
    const diarization = transcript
      ? this.toDiarization(mediaId, transcript)
      : null;
    return {
      mediaId,
      status: statusOf(job, result),
      transcriber: presence.transcriber,
      transcriberOffSince: presence.offSince,
      canRequest:
        media.status === 'ready' && transcript !== undefined && !isPending(job),
      diarization,
      voiceSuggestions: this.suggestionsOn(media, diarization),
    };
  }

  /** "Parece ser", for the voices with no name yet (KBC-071 FR-3). */
  private suggestionsOn(media: MediaRecord, diarization: Diarization | null) {
    const result = this.deps.diarizations.latest(media.id);
    if (!diarization || !result) return [];
    return (
      this.deps.voicePrints?.suggestions({
        media,
        diarizationId: result.id,
        voices: diarization.labels
          .filter((label) => label.kind === 'unnamed')
          .map((label) => label.voice),
      }) ?? []
    );
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
      // Read here, with no await before the store: a name saved while the file was being
      // written still reaches the new separation (BR-5).
      stored = diarizations.completeDiarize({
        owner,
        now: this.now(),
        diarization: {
          ...diarization,
          ...this.carriedNames(job.mediaId, diarization.turns),
        },
      });
    } finally {
      if (!stored) await files.remove([diarization.rawPath]);
    }
    if (!stored) throw leaseLost();
    this.recordMatches(job.mediaId, diarization.id, done);
  }

  /** What the Mac found by voice, on this separation's voice numbers (KBC-071 FR-3). */
  private recordMatches(
    mediaId: string,
    diarizationId: string,
    done: CompleteDiarizeRequest,
  ): void {
    const media = this.deps.store.getMedia(mediaId);
    const { voicePrints } = this.deps;
    if (!media || !voicePrints) return;
    const numbers = voiceNumbersOf(done.raw.turns, media.durationMs);
    voicePrints.recordMatches({
      media,
      diarizationId,
      matches: (done.voiceMatches ?? []).flatMap((match) => {
        const voice = numbers.get(match.voice);
        return voice === undefined ? [] : [{ ...match, voice }];
      }),
    });
  }

  /**
   * Checks the turns against the item and the job, and derives what is stored with them;
   * more voices than the person announced is a wrong result, refused whole. The names come
   * last, in `complete`.
   */
  private derive(
    mediaId: string,
    done: CompleteDiarizeRequest,
  ): Omit<NewDiarization, 'labels' | 'namesPending'> {
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
      ...this.voicesOfTurns(transcript.id, turns),
    };
  }

  /** The names of the separation before, by the time the voices share (FR-5, BR-5). */
  private carriedNames(
    mediaId: string,
    turns: readonly SpeakerTurn[],
  ): { labels: CarriedLabel[]; namesPending: boolean } {
    const { diarizations, voiceLabels } = this.deps;
    const previous = diarizations.latest(mediaId);
    if (!previous) return { labels: [], namesPending: false };
    const before = voiceLabels.labels(previous.id);
    return {
      labels: carryLabels({
        labels: before,
        oldTurns: mergeTurns(diarizations.turns(previous.id), aliasOf(before)),
        newTurns: turns,
      }),
      namesPending: before.some(
        (one) =>
          one.mergedInto === null && (one.speaker !== null || one.audience),
      ),
    };
  }

  /** The voice of each segment and word of a transcript. */
  private voicesOfTurns(transcriptId: string, turns: readonly SpeakerTurn[]) {
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
   * The current separation on `transcript` (FR-4), null before the first: on the transcript
   * it was made on, the stored voices; on a newer one (BR-3), the same turns placed on the
   * new segments, flagged as made on an older transcript.
   */
  voicesOn(
    mediaId: string,
    transcript: TranscriptSummary,
  ): TranscriptVoices | null {
    const { diarizations, transcripts } = this.deps;
    const result = diarizations.latest(mediaId);
    if (!result) return null;
    const rows = this.deps.voiceLabels.labels(result.id);
    const alias = aliasOf(rows);
    const turns = mergeTurns(diarizations.turns(result.id), alias);
    const stale = result.transcriptId !== transcript.id;
    return {
      speakers: this.speakersOf({ result, transcript, rows, turns, stale }),
      segmentVoices: stale
        ? dominantVoices(transcripts.segments(transcript.id), turns)
        : readAs(diarizations.segmentVoices(result.id), alias),
    };
  }

  /** The separation as read: joined voices as one, each voice with who it is. */
  private speakersOf(input: {
    result: DiarizationSummary;
    transcript: TranscriptSummary;
    rows: readonly StoredVoiceLabel[];
    turns: readonly SpeakerTurn[];
    stale: boolean;
  }): TranscriptSpeakers {
    const { result, transcript, rows, turns, stale } = input;
    const voices = speakingTimeOf(turns);
    return {
      version: result.version,
      createdAt: result.createdAt,
      transcriptVersion: transcript.version,
      staleTranscript: stale,
      requestedVoices: result.requestedVoices,
      voiceCount: voices.length,
      voices,
      turns: [...turns],
      labels: this.labelsOf(voices, rows),
      merged: mergedOf(rows),
      namesPending: result.namesPending,
    };
  }

  /** One label per voice shown, a voice with no row being unnamed. */
  private labelsOf(
    voices: readonly { readonly voice: number }[],
    rows: readonly StoredVoiceLabel[],
  ) {
    const authorOf = this.deps.authorOf ?? (() => null);
    return voices.map(({ voice }) =>
      voiceLabelOf(
        voice,
        rows.find((row) => row.voice === voice),
        authorOf,
      ),
    );
  }

  private toDiarization(
    mediaId: string,
    transcript: TranscriptSummary,
  ): Diarization | null {
    const voices = this.voicesOn(mediaId, transcript);
    if (!voices) return null;
    const segments = this.deps.transcripts.segments(transcript.id);
    return {
      ...voices.speakers,
      segments: segments.map((segment, index) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        voice: voices.segmentVoices[index] ?? null,
      })),
    };
  }

  private visible(actor: MediaActor, mediaId: string): MediaRecord {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !actor.canSee(media.topic)) throw notFound();
    return media;
  }
}

/** The voices of the segments, joined ones as the voice they read as. */
const readAs = (
  voices: readonly (number | null)[],
  alias: ReadonlyMap<number, number>,
): (number | null)[] =>
  voices.map((voice) => (voice === null ? null : (alias.get(voice) ?? voice)));

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

import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  CompleteTranscribeRequest,
  TranscriptProvider,
  TranscriptionTerms,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { LeaseOwner, MediaStorePort } from '../../ports/media-store.js';
import type {
  JobLease,
  NewTranscript,
  TranscriptStorePort,
} from '../../ports/transcript-store.js';
import { assertPlausible } from './transcript-bounds.js';
import { CONFIDENCE_VERSION, confidenceOf } from './transcript-confidence.js';
import { FILTER_VERSION, deriveTranscript } from './transcript-filter.js';
import type { PlayableFile } from './media-service.js';

export interface TranscriptionServiceDeps {
  readonly store: MediaStorePort;
  readonly transcripts: TranscriptStorePort;
  readonly files: MediaFilesPort;
  /** The recording's new transcript is in: its tracks follow in that transaction (KBC-068). */
  readonly onTranscript?: (mediaId: string) => void;
  /** The list to prompt with, learned terms included (KBC-113 FR-4); the newest otherwise. */
  readonly terms?: () => TranscriptionTerms;
  readonly now?: () => Date;
}

const FLAC_MIME = 'audio/flac';

const notYours = () => new AppError('NOT_FOUND', 'No such job for this worker');
const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');
const unknownTerms = () =>
  new AppError('VALIDATION_FAILED', 'No such version of the term list', {
    details: { field: 'termsVersion' },
  });

/** A raw result from the Mac (mlx-whisper) or from Groq (KBC-037), lease aside. */
export type TranscriptResult = Omit<
  CompleteTranscribeRequest,
  'provider' | 'worker' | 'leaseId'
> &
  Partial<Pick<CompleteTranscribeRequest, 'worker' | 'leaseId'>> & {
    readonly provider: TranscriptProvider;
  };

/** How a transcript was made: the worker's model, parameters, terms and VAD. */
const provenanceOf = (done: TranscriptResult) => ({
  provider: done.provider,
  model: done.model,
  parameters: JSON.stringify(done.parameters),
  parametersVersion: done.parametersVersion,
  termsVersion: done.termsVersion,
  vad: done.vad,
  speechRatio: done.speechRatio,
  elapsedMs: done.elapsedMs,
});

/** The raw result as stored: everything the worker sent but its lease (ADR 0023 §4). */
function rawFileOf(done: TranscriptResult): string {
  return JSON.stringify({
    provider: done.provider,
    model: done.model,
    parametersVersion: done.parametersVersion,
    parameters: done.parameters,
    termsVersion: done.termsVersion,
    vad: done.vad,
    speechRatio: done.speechRatio,
    elapsedMs: done.elapsedMs,
    raw: done.raw,
  });
}

/**
 * The transcriber's side of a transcribe job (ADR 0023): the term list, the job's audio
 * and the raw result, which the API keeps and derives (segments, words, filter, confidence).
 */
export class TranscriptionService {
  private readonly now: () => Date;

  constructor(private readonly deps: TranscriptionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  terms(): TranscriptionTerms {
    return this.deps.terms?.() ?? this.deps.transcripts.currentTerms();
  }

  /**
   * The audio of a transcription or voice separation this worker holds (BR-2): the 16 kHz
   * FLAC, or the audio rendition when there is none (a separation usually comes after the
   * FLAC went, ADR 0022 §4). Any other job is 404, not even confirmed to exist.
   */
  async audio(owner: LeaseOwner): Promise<PlayableFile> {
    const job = this.heldSpeechJob(owner);
    if (!job) throw notYours();
    return this.audioOf(job.mediaId);
  }

  /**
   * One of the recordings a `voice-profile` job uses (KBC-071 FR-2): `usesMedia` says whether
   * the lease covers it.
   */
  async sourceAudio(input: {
    readonly mediaId: string;
    readonly usesMedia: boolean;
  }): Promise<PlayableFile> {
    if (!input.usesMedia) throw notYours();
    return this.audioOf(input.mediaId);
  }

  private async audioOf(mediaId: string): Promise<PlayableFile> {
    const { files, store } = this.deps;
    const flac = await files.stat(files.flacPath(mediaId));
    if (flac)
      return { path: files.flacPath(mediaId), mime: FLAC_MIME, ...flac };
    const rendition = store.getRendition(mediaId);
    const file = rendition ? await files.stat(rendition.path) : null;
    if (!rendition || !file) throw notYours();
    return { path: rendition.path, mime: rendition.mime, ...file };
  }

  /**
   * Keeps the raw JSON as a file, derives it and stores the new version (BR-3, FR-3) in
   * one transaction with the job's end. A lost lease drops the file and is 409.
   */
  async complete(owner: LeaseOwner, done: TranscriptResult): Promise<void> {
    const job = this.heldTranscription(owner);
    if (!job) throw leaseLost();
    const { files, transcripts, store } = this.deps;
    const used = transcripts.termsAt(done.termsVersion);
    if (!used) throw unknownTerms();
    assertPlausible(done.raw, store.getMedia(job.mediaId)?.durationMs ?? null);
    const id = randomUUID();
    const rawPath = files.transcriptPath(job.mediaId, id);
    const transcript = this.derive({
      ids: { id, mediaId: job.mediaId, rawPath },
      done,
      terms: used.terms,
    });
    if (this.wouldEraseText(transcript)) return this.dropEmpty(owner);
    await files.writeFile(rawPath, rawFileOf(done));
    if (!this.store(owner, transcript)) {
      await files.remove([rawPath]);
      throw leaseLost();
    }
    // ADR 0022 §4: the FLAC is made for the transcription and goes once it is stored.
    await files.remove([files.flacPath(job.mediaId)]);
  }

  /** Tracks follow in the same transaction (KBC-068). */
  private store(owner: LeaseOwner, transcript: NewTranscript): boolean {
    return this.deps.transcripts.completeTranscribe({
      owner,
      transcript,
      now: this.now(),
      alongside: () => this.deps.onTranscript?.(transcript.mediaId),
    });
  }

  /** An empty result would take the text, the subtitles and the search hits with it. */
  private wouldEraseText(transcript: NewTranscript): boolean {
    const [current] = this.deps.transcripts.transcripts(transcript.mediaId);
    return transcript.wordCount === 0 && (current?.wordCount ?? 0) > 0;
  }

  /** The attempt ends as failed, for good, and the current transcript stays (KBC-040 BR-3). */
  private dropEmpty(owner: LeaseOwner): void {
    const failed = this.deps.store.failJob({
      ...owner,
      failure: 'invalid-audio',
      detail: 'The new transcription came back empty',
      now: this.now(),
      maxAttempts: 1,
    });
    if (!failed) throw leaseLost();
  }

  /** The bytes `start..end` of the job's audio. */
  openRange(path: string, range: { start: number; end: number }): Readable {
    return this.deps.files.read(path, range);
  }

  /** With the list the job was prompted with: only that one can leak into the text. */
  private derive(input: {
    ids: { id: string; mediaId: string; rawPath: string };
    done: TranscriptResult;
    terms: readonly string[];
  }): NewTranscript {
    const { done, ids } = input;
    const derived = deriveTranscript(done.raw, input.terms);
    const verdict = confidenceOf(derived);
    return {
      ...ids,
      ...provenanceOf(done),
      filterVersion: FILTER_VERSION,
      confidenceVersion: CONFIDENCE_VERSION,
      confidence: verdict.confidence,
      wordCount: verdict.wordCount,
      removedWords: derived.stats.removedWords,
      lowWords: verdict.doubtedWords,
      segments: derived.segments,
      words: derived.words,
    };
  }

  /** A job whose audio a paired transcriber may fetch: a transcription or a separation. */
  private heldSpeechJob(owner: LeaseOwner): JobLease | null {
    const job = this.deps.transcripts.heldJob(owner);
    return job?.kind === 'transcribe' || job?.kind === 'diarize' ? job : null;
  }

  private heldTranscription(owner: LeaseOwner): JobLease | null {
    const job = this.deps.transcripts.heldJob(owner);
    return job?.kind === 'transcribe' ? job : null;
  }
}
